import { Context, Effect, Encoding, Layer, Match, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import type {
  GeneratedImage,
  ImageBase64Source,
  ImageBytesSource,
  ImageSource,
} from "@effect-uai/core/Image"
import { imageBase64 } from "@effect-uai/core/Image"
import type {
  CommonImageEditRequest,
  CommonImageGenerateRequest,
  CommonStreamImageRequest,
  ImageGeneratorService,
  ImageResponse,
  ImageStreamEvent,
  ImageUsage,
} from "@effect-uai/core/ImageGenerator"
import { ImageGenerator } from "@effect-uai/core/ImageGenerator"
import { httpStatusError, transportFailure } from "./codec.js"
import type { GeminiImageModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Wire knobs `generateContent` accepts alongside the portable request. */
type GeminiImageKnobs = {
  /**
   * Sent as `imageConfig.imageSize`. Takes precedence over `resolution`,
   * which is then warn-dropped. `"512"` is Flash-only.
   */
  readonly imageSize?: "512" | "1K" | "2K" | "4K"
  /** Thinking is always on for image models; this only sets how long. */
  readonly thinkingLevel?: "minimal" | "low" | "medium" | "high"
  /** Ground the image in web results. Flash and Pro only. */
  readonly googleSearch?: boolean
}

export type GeminiImageGenerateRequest = Omit<CommonImageGenerateRequest, "model"> & {
  readonly model: GeminiImageModel
} & GeminiImageKnobs

/**
 * Reference images for an edit. Narrowed off `ImageSource`: references
 * ride in the request body as base64 `inlineData`, so a `url` variant has
 * no wire representation short of pre-uploading through the Files API.
 * A compile-time error rather than a 400; fetch it yourself and pass the
 * bytes.
 */
export type GeminiImageRef = ImageBase64Source | ImageBytesSource

export type GeminiImageEditRequest = Omit<CommonImageEditRequest, "model" | "images"> & {
  readonly model: GeminiImageModel
  /** 14 total, split between object / character / style refs per model. */
  readonly images: ReadonlyArray<GeminiImageRef>
} & GeminiImageKnobs

export type GeminiImageGeneratorService = {
  readonly generate: (
    request: GeminiImageGenerateRequest,
  ) => Effect.Effect<ImageResponse, AiError.AiError>
  readonly edit: (request: GeminiImageEditRequest) => Effect.Effect<ImageResponse, AiError.AiError>
  /** Always `Unsupported`: `ImageStreaming` is not registered by {@link layer}. */
  readonly streamGeneration: ImageGeneratorService["streamGeneration"]
}

/**
 * Provider-typed service tag. Yield this for `imageSize`, `thinkingLevel`
 * and search grounding; yield the generic `ImageGenerator` tag for
 * provider-portable code. Both are registered by {@link layer}.
 */
export class GeminiImageGenerator extends Context.Service<
  GeminiImageGenerator,
  GeminiImageGeneratorService
>()("@betalyra/effect-uai/providers/google/GeminiImageGenerator") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

const PROVIDER = "gemini"

// ---------------------------------------------------------------------------
// Codec - request
//
// Both ratio and tier are native here, so nothing is derived. Whether a
// given model accepts the pair is the server's call: per-model limits
// churn and we do not table them.
// ---------------------------------------------------------------------------

type ImageConfig = {
  readonly aspectRatio?: string
  readonly imageSize?: string
}

type RequestPart =
  | { readonly text: string }
  | { readonly inlineData: { readonly mimeType: string; readonly data: string } }

export type WireBody = {
  readonly contents: ReadonlyArray<{
    readonly role: "user"
    readonly parts: ReadonlyArray<RequestPart>
  }>
  readonly generationConfig: {
    readonly responseModalities: ReadonlyArray<"TEXT" | "IMAGE">
    readonly imageConfig?: ImageConfig
    readonly thinkingConfig?: { readonly thinkingLevel: string }
  }
  readonly tools?: ReadonlyArray<{ readonly googleSearch: {} }>
}

const urlRefNotSupported: AiError.AiError = new AiError.InvalidRequest({
  provider: PROVIDER,
  param: "images",
  raw: 'Reference images ride in the request body as base64, so a URL reference cannot be sent without pre-uploading it through the Files API. Fetch the URL yourself and pass `{ _tag: "bytes", bytes, mimeType }`.',
})

const referencePart: (image: ImageSource) => Effect.Effect<RequestPart, AiError.AiError> =
  Match.type<ImageSource>().pipe(
    Match.tag("base64", (i) =>
      Effect.succeed<RequestPart>({ inlineData: { mimeType: i.mimeType, data: i.base64 } }),
    ),
    Match.tag("bytes", (i) =>
      Effect.succeed<RequestPart>({
        inlineData: { mimeType: i.mimeType, data: Encoding.encodeBase64(i.bytes) },
      }),
    ),
    Match.tag("url", () => Effect.fail(urlRefNotSupported)),
    Match.exhaustive,
  )

/**
 * More than one image per call is bucket 1: `candidateCount` is a generic
 * `generationConfig` field whose behaviour on image models is undocumented,
 * and silently returning one image where several were asked for is a
 * different result, not a smaller one.
 */
const rejectMultiple = (n: number | undefined): Effect.Effect<void, AiError.AiError> =>
  n === undefined || n <= 1
    ? Effect.void
    : Effect.fail(
        new AiError.Unsupported({
          provider: PROVIDER,
          capability: "n",
          reason: `Gemini image models return one image per call; \`n: ${n}\` has no wire field. Run the request ${n} times, concurrently if you want them at once.`,
        }),
      )

/** The typed `imageSize` wins over the portable tier, which is then dropped. */
export const imageSizeOf = (
  request: Pick<GeminiImageGenerateRequest, "imageSize" | "resolution">,
): Effect.Effect<string | undefined> =>
  request.imageSize === undefined
    ? Effect.succeed(request.resolution)
    : Effect.as(
        Capabilities.warnDroppedWhen(request.resolution, {
          provider: PROVIDER,
          capability: "resolution",
          field: "resolution",
          reason: `\`imageSize: "${request.imageSize}"\` sets the tier directly.`,
        }),
        request.imageSize,
      )

export const buildBody = (
  request: GeminiImageGenerateRequest,
  images: ReadonlyArray<ImageSource>,
): Effect.Effect<WireBody, AiError.AiError> =>
  Effect.gen(function* () {
    yield* rejectMultiple(request.n)
    const imageSize = yield* imageSizeOf(request)
    const refs = yield* Effect.forEach(images, referencePart)
    const imageConfig: ImageConfig = {
      ...(request.aspectRatio !== undefined && { aspectRatio: request.aspectRatio }),
      ...(imageSize !== undefined && { imageSize }),
    }
    return {
      contents: [{ role: "user", parts: [{ text: request.prompt }, ...refs] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(Object.keys(imageConfig).length > 0 && { imageConfig }),
        ...(request.thinkingLevel !== undefined && {
          thinkingConfig: { thinkingLevel: request.thinkingLevel.toUpperCase() },
        }),
      },
      ...(request.googleSearch === true && { tools: [{ googleSearch: {} }] }),
    }
  })

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const InlineData = Schema.Struct({
  mimeType: Schema.optional(Schema.String),
  data: Schema.String,
})

const Part = Schema.Struct({
  text: Schema.optional(Schema.String),
  inlineData: Schema.optional(InlineData),
  /** Interim images the model drew while thinking. Not the answer. */
  thought: Schema.optional(Schema.Boolean),
})

const Candidate = Schema.Struct({
  content: Schema.optional(Schema.Struct({ parts: Schema.optional(Schema.Array(Part)) })),
  finishReason: Schema.optional(Schema.String),
})

const UsageMetadata = Schema.Struct({
  promptTokenCount: Schema.optional(Schema.Number),
  candidatesTokenCount: Schema.optional(Schema.Number),
  totalTokenCount: Schema.optional(Schema.Number),
})
type UsageMetadata = typeof UsageMetadata.Type

const Wire = Schema.Struct({
  candidates: Schema.optional(Schema.Array(Candidate)),
  promptFeedback: Schema.optional(Schema.Struct({ blockReason: Schema.optional(Schema.String) })),
  usageMetadata: Schema.optional(UsageMetadata),
})
type Wire = typeof Wire.Type

export const decodeWire = Schema.decodeUnknownEffect(Wire)

/**
 * Finish reasons that are a content decision rather than a failure. The
 * generic safety codes appear when the prompt trips a filter, the
 * `IMAGE_`-prefixed ones when the drawn image does. `NO_IMAGE` and
 * `IMAGE_OTHER` are not here: they say the model produced nothing, not
 * that it refused.
 */
const FILTERED_FINISH_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
])

const usageOf = (usage: UsageMetadata | undefined): ImageUsage => ({
  ...(usage?.promptTokenCount !== undefined && { inputTokens: usage.promptTokenCount }),
  ...(usage?.candidatesTokenCount !== undefined && { outputTokens: usage.candidatesTokenCount }),
  ...(usage?.totalTokenCount !== undefined && { totalTokens: usage.totalTokenCount }),
})

/** Every Gemini image carries SynthID; Lite adds a C2PA manifest on top. */
const generatedImage = (inline: typeof InlineData.Type): GeneratedImage => ({
  image: imageBase64(inline.data, inline.mimeType ?? "image/png"),
  watermark: "synthid",
})

export const toResponse = (wire: Wire): Effect.Effect<ImageResponse, AiError.AiError> => {
  const blockReason = wire.promptFeedback?.blockReason
  const finishReason = wire.candidates?.[0]?.finishReason
  // A prompt-level block names itself; an output-level one shows up as the
  // candidate's finish reason with no parts attached.
  const filtered =
    blockReason ??
    (finishReason !== undefined && FILTERED_FINISH_REASONS.has(finishReason)
      ? finishReason
      : undefined)
  if (filtered !== undefined) {
    return Effect.fail(
      new AiError.ContentFiltered({ provider: PROVIDER, reason: filtered, raw: wire }),
    )
  }
  const images = (wire.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .flatMap((part) =>
      part.thought === true || part.inlineData === undefined
        ? []
        : [generatedImage(part.inlineData)],
    )
  return images.length === 0
    ? Effect.fail(
        new AiError.GenerationFailed({
          provider: PROVIDER,
          ...(finishReason !== undefined && { code: finishReason }),
          message: "Gemini returned no image part.",
          raw: wire,
        }),
      )
    : Effect.succeed({ images, usage: usageOf(wire.usageMetadata) })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const host = (cfg: Config): string =>
  cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"

const requestImages = (
  cfg: Config,
  request: GeminiImageGenerateRequest,
  images: ReadonlyArray<ImageSource>,
): Effect.Effect<ImageResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* buildBody(request, images)
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${host(cfg)}/models/${request.model}:generateContent`).pipe(
          HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey)),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.mapError(transportFailure(PROVIDER)))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(PROVIDER)(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure(PROVIDER)))
    const wire = yield* decodeWire(json).pipe(Effect.mapError(transportFailure(PROVIDER)))
    return yield* toResponse(wire)
  })

/**
 * `generateContent` has no partial-image wire, so this never succeeds and
 * {@link layer} does not register `ImageStreaming`. Code calling the
 * top-level `streamGeneration` helper against this Layer alone fails to
 * typecheck, which is the intended UX; this branch covers the service
 * being used directly.
 */
const streamUnsupported = (): Stream.Stream<ImageStreamEvent, AiError.AiError> =>
  Stream.fail(
    new AiError.Unsupported({
      provider: PROVIDER,
      capability: "streamGeneration",
      reason:
        "Gemini image models have no partial-image wire; the image arrives whole. Use `generate` and render when it resolves.",
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<GeminiImageGeneratorService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client): GeminiImageGeneratorService => ({
    generate: (request) =>
      requestImages(cfg, request, []).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    edit: (request) =>
      requestImages(cfg, request, request.images).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ),
    streamGeneration: streamUnsupported,
  }))

/**
 * Layer registering the provider-typed tag and the generic
 * `ImageGenerator`. A `CommonImageGenerateRequest` is structurally a
 * `GeminiImageGenerateRequest` with no vendor knobs set, so the generic
 * registration forwards directly; a URL reference slipping through the
 * generic `edit` fails `InvalidRequest` at encode time.
 *
 * Does NOT register `ImageStreaming`.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<GeminiImageGenerator | ImageGenerator, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(GeminiImageGenerator, make(cfg)),
    Layer.effect(
      ImageGenerator,
      Effect.map(make(cfg), (s): ImageGeneratorService => ({
        generate: (request: CommonImageGenerateRequest) =>
          s.generate(request as GeminiImageGenerateRequest),
        edit: (request: CommonImageEditRequest) => s.edit(request as GeminiImageEditRequest),
        streamGeneration: (_request: CommonStreamImageRequest) => streamUnsupported(),
      })),
    ),
  )
