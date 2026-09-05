import { Context, Effect, Layer, type Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import type {
  GeneratedImage,
  ImageBase64Source,
  ImageBytesSource,
  ImageMimeType,
  ImageResolution,
} from "@effect-uai/core/Image"
import { imageBase64, imageUrl } from "@effect-uai/core/Image"
import type {
  CommonImageEditRequest,
  CommonImageGenerateRequest,
  CommonStreamImageEditRequest,
  CommonStreamImageRequest,
  ImageGeneratorService,
  ImageResponse,
  ImageUsage,
} from "@effect-uai/core/ImageGenerator"
import { ImageGenerator, ImageStreamEvent, ImageStreaming } from "@effect-uai/core/ImageGenerator"
import * as SSE from "@effect-uai/core/SSE"
import { bodyMultipart, httpStatusError, imageToBlob, transportFailure } from "./codec.js"
import type { OpenAIImageModel } from "./models.js"
import { type OpenAiRegion, resolveHost } from "./region.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Wire knobs shared by `/images/generations` and `/images/edits`. */
type OpenAIImageKnobs = {
  /**
   * Exact `"WxH"` or `"auto"`. Takes precedence over `aspectRatio` and
   * `resolution`, which are then warn-dropped.
   */
  readonly size?: string
  readonly quality?: "low" | "medium" | "high" | "auto"
  /** `"transparent"` requires a png or webp `outputFormat`. */
  readonly background?: "transparent" | "opaque" | "auto"
  readonly outputFormat?: "png" | "jpeg" | "webp"
  /** 0..100, jpeg and webp only. */
  readonly outputCompression?: number
  readonly moderation?: "low" | "auto"
}

export type OpenAIImageGenerateRequest = Omit<CommonImageGenerateRequest, "model"> & {
  readonly model: OpenAIImageModel
} & OpenAIImageKnobs

/**
 * Reference images for an edit. Narrowed off `ImageSource`: the endpoint's
 * multipart body uploads bytes, so a `url` variant has no wire
 * representation here and is a compile-time error rather than a 400.
 * Fetch it yourself and pass the bytes.
 */
export type OpenAIImageRef = ImageBase64Source | ImageBytesSource

export type OpenAIImageEditRequest = Omit<CommonImageEditRequest, "model" | "images"> & {
  readonly model: OpenAIImageModel
  readonly images: ReadonlyArray<OpenAIImageRef>
} & OpenAIImageKnobs & {
    /** PNG with an alpha channel, same dimensions as `images[0]`, which it applies to. */
    readonly mask?: OpenAIImageRef
  }

export type OpenAIStreamImageRequest = Omit<CommonStreamImageRequest, "model"> & {
  readonly model: OpenAIImageModel
} & OpenAIImageKnobs

export type OpenAIStreamImageEditRequest = OpenAIImageEditRequest & {
  readonly partialImages: 1 | 2 | 3
}

export type OpenAIImageGeneratorService = {
  readonly generate: (
    request: OpenAIImageGenerateRequest,
  ) => Effect.Effect<ImageResponse, AiError.AiError>
  readonly edit: (request: OpenAIImageEditRequest) => Effect.Effect<ImageResponse, AiError.AiError>
  readonly streamGeneration: (
    request: OpenAIStreamImageRequest,
  ) => Stream.Stream<ImageStreamEvent, AiError.AiError>
  readonly streamEdit: (
    request: OpenAIStreamImageEditRequest,
  ) => Stream.Stream<ImageStreamEvent, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for exact pixel sizes, quality
 * tiers, transparency, and masks; yield the generic `ImageGenerator` tag
 * for provider-portable code. Both are registered by `layer`.
 */
export class OpenAIImageGenerator extends Context.Service<
  OpenAIImageGenerator,
  OpenAIImageGeneratorService
>()("@betalyra/effect-uai/providers/openai/OpenAIImageGenerator") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: OpenAiRegion
}

// ---------------------------------------------------------------------------
// Codec - size
//
// The portable request carries a ratio and a tier; this endpoint wants
// `"WxH"`. Whether the derived pair is in range for the model is the
// server's call: per-model limits churn and we do not table them.
// ---------------------------------------------------------------------------

const SHORT_EDGE: Record<ImageResolution, number> = { "1K": 1024, "2K": 2048, "4K": 4096 }

/** The API requires both edges to be multiples of 16. */
const round16 = (n: number): number => Math.max(16, Math.round(n / 16) * 16)

const positive = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n > 0

/** Fails when the ratio is not arithmetic we can turn into pixels. */
const parseRatio = (ratio: string): Effect.Effect<readonly [number, number], AiError.AiError> => {
  const [w, h, ...rest] = ratio.split(":").map(Number)
  return positive(w) && positive(h) && rest.length === 0
    ? Effect.succeed([w, h] as const)
    : Effect.fail(
        new AiError.InvalidRequest({
          provider: "openai",
          param: "aspectRatio",
          raw: `Cannot derive pixel dimensions from aspectRatio "${ratio}": the Images API takes "WxH", so the ratio must read "W:H" with positive numbers. Set \`size\` directly to bypass the derivation.`,
        }),
      )
}

/**
 * Derive `"WxH"`: the tier is the short edge, the long edge follows the
 * ratio, both rounded to 16. `undefined` means "send no size" and let the
 * endpoint pick.
 */
export const sizeOf = (
  request: Pick<OpenAIImageGenerateRequest, "size" | "aspectRatio" | "resolution">,
): Effect.Effect<string | undefined, AiError.AiError> =>
  Effect.gen(function* () {
    if (request.size !== undefined) {
      // Explicit pixels win, but the shape the caller also asked for is one
      // they will not get: say so rather than drop it silently.
      const overridden = `\`size: "${request.size}"\` sets the dimensions directly.`
      yield* Capabilities.warnDroppedWhen(request.aspectRatio, {
        provider: "openai",
        capability: "aspectRatio",
        field: "aspectRatio",
        reason: overridden,
      })
      yield* Capabilities.warnDroppedWhen(request.resolution, {
        provider: "openai",
        capability: "resolution",
        field: "resolution",
        reason: overridden,
      })
      return request.size
    }
    if (request.aspectRatio === undefined && request.resolution === undefined) return undefined
    const short = SHORT_EDGE[request.resolution ?? "1K"]
    const [w, h] = yield* parseRatio(request.aspectRatio ?? "1:1")
    return w >= h ? `${round16((short * w) / h)}x${short}` : `${short}x${round16((short * h) / w)}`
  })

// ---------------------------------------------------------------------------
// Codec - request bodies
// ---------------------------------------------------------------------------

export type WireBody = {
  readonly prompt: string
  readonly model: string
  readonly n?: number
  readonly size?: string
  readonly quality?: string
  readonly background?: string
  readonly output_format?: string
  readonly output_compression?: number
  readonly moderation?: string
  readonly stream?: boolean
  readonly partial_images?: number
}

// Out-of-range values (`n` above 10, compression above 100, an impossible
// `size`) go out as given: the endpoint adjudicates and its 400 is
// translated, so no range table lives here.
const knobFields = (
  request: OpenAIImageKnobs & { readonly n?: number },
  size: string | undefined,
) => ({
  ...(request.n !== undefined && { n: request.n }),
  ...(size !== undefined && { size }),
  ...(request.quality !== undefined && { quality: request.quality }),
  ...(request.background !== undefined && { background: request.background }),
  ...(request.outputFormat !== undefined && { output_format: request.outputFormat }),
  ...(request.outputCompression !== undefined && { output_compression: request.outputCompression }),
  ...(request.moderation !== undefined && { moderation: request.moderation }),
})

export const generateBody = (
  request: OpenAIImageGenerateRequest,
): Effect.Effect<WireBody, AiError.AiError> =>
  Effect.map(sizeOf(request), (size) => ({
    prompt: request.prompt,
    model: request.model,
    ...knobFields(request, size),
  }))

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

/** The endpoint reads the format off the filename, not the content type. */
const fileName = (blob: Blob, index: number): string =>
  `image-${index}.${EXTENSION_BY_MIME[blob.type] ?? "png"}`

/**
 * Multipart edit body. The endpoint also documents a JSON variant taking
 * `images[]` as URL or data-URL references, but it is not universally
 * served: Azure-backed routes validate against this schema and reject the
 * JSON one with "Missing required parameter: 'image'". Multipart works
 * everywhere, so it is the only variant sent.
 *
 * References upload as repeated `image[]` parts, so they must be inline
 * bytes; a URL source fails `InvalidRequest`.
 */
export const editForm = (
  request: OpenAIImageEditRequest,
): Effect.Effect<FormData, AiError.AiError> =>
  Effect.gen(function* () {
    const size = yield* sizeOf(request)
    const blobs = yield* Effect.forEach(request.images, imageToBlob)
    const form = new FormData()
    form.set("prompt", request.prompt)
    form.set("model", request.model)
    // The endpoint's required field is `image`, a single file. Only the
    // multi-reference form uses the repeated `image[]`, and a server that
    // implements just the single-file schema rejects `image[]` outright.
    const field = blobs.length > 1 ? "image[]" : "image"
    blobs.forEach((blob, index) => form.append(field, blob, fileName(blob, index)))
    if (request.mask !== undefined) {
      const mask = yield* imageToBlob(request.mask)
      form.set("mask", mask, fileName(mask, 0))
    }
    Object.entries(knobFields(request, size)).forEach(([key, value]) =>
      form.set(key, String(value)),
    )
    return form
  })

/** The edit form plus the two streaming fields, which multipart sends as strings. */
export const streamEditForm = (
  request: OpenAIStreamImageEditRequest,
): Effect.Effect<FormData, AiError.AiError> =>
  Effect.map(editForm(request), (form) => {
    form.set("stream", "true")
    form.set("partial_images", String(request.partialImages))
    return form
  })

export const streamBody = (
  request: OpenAIStreamImageRequest,
): Effect.Effect<WireBody, AiError.AiError> =>
  Effect.map(generateBody(request), (body) => ({
    ...body,
    stream: true,
    partial_images: request.partialImages,
  }))

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
})
type WireUsage = typeof WireUsage.Type

// `created`, `usage`, `url`, and `revised_prompt` stay optional so the
// narrower payloads served by OpenAI-compatible gateways decode too.
const WireImagesResponse = Schema.Struct({
  created: Schema.optional(Schema.Number),
  data: Schema.Array(
    Schema.Struct({
      b64_json: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
      revised_prompt: Schema.optional(Schema.String),
    }),
  ),
  output_format: Schema.optional(Schema.String),
  usage: Schema.optional(WireUsage),
})
type WireImagesResponse = typeof WireImagesResponse.Type

export const decodeImagesResponse = Schema.decodeUnknownEffect(WireImagesResponse)

const MIME_BY_FORMAT: Record<string, ImageMimeType> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
}

/** The response echoes the realized format; the request's is the fallback. */
const mimeOf = (
  wireFormat: string | undefined,
  requested: OpenAIImageKnobs["outputFormat"],
): ImageMimeType => MIME_BY_FORMAT[wireFormat ?? requested ?? "png"] ?? "image/png"

const usageOf = (usage: WireUsage | undefined): ImageUsage => ({
  ...(usage?.input_tokens !== undefined && { inputTokens: usage.input_tokens }),
  ...(usage?.output_tokens !== undefined && { outputTokens: usage.output_tokens }),
  ...(usage?.total_tokens !== undefined && { totalTokens: usage.total_tokens }),
})

// GPT image models always return base64; `url` is decoded for gateways that
// hand back a link instead. No watermark: OpenAI documents none.
const imageOf = (
  entry: WireImagesResponse["data"][number],
  mime: ImageMimeType,
): GeneratedImage | undefined =>
  entry.b64_json !== undefined
    ? { image: imageBase64(entry.b64_json, mime) }
    : entry.url !== undefined
      ? { image: imageUrl(entry.url, mime) }
      : undefined

export const toResponse = (
  wire: WireImagesResponse,
  requested: OpenAIImageKnobs["outputFormat"],
): Effect.Effect<ImageResponse, AiError.AiError> => {
  const mime = mimeOf(wire.output_format, requested)
  const images = wire.data.flatMap((entry) => {
    const image = imageOf(entry, mime)
    return image === undefined ? [] : [image]
  })
  return images.length === 0
    ? Effect.fail(
        new AiError.GenerationFailed({
          provider: "openai",
          message: "OpenAI returned no image data.",
          raw: wire,
        }),
      )
    : Effect.succeed({ images, usage: usageOf(wire.usage) })
}

// ---------------------------------------------------------------------------
// Codec - errors
// ---------------------------------------------------------------------------

const WireError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optional(Schema.NullOr(Schema.String)),
    message: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
  }),
})
type WireError = typeof WireError.Type

const decodeWireError = Schema.decodeUnknownEffect(Schema.fromJsonString(WireError))

/**
 * A moderation refusal is a content decision, not a malformed request, so
 * it leaves the status mapping and becomes `ContentFiltered`. Both the
 * documented markers are checked: `moderation_details` is docs-only and
 * absent from the OpenAPI error schema, so it is not relied on.
 */
const moderationOf = (wire: WireError, raw: string): AiError.AiError | undefined => {
  const { error } = wire
  return error.code === "moderation_blocked" || error.type === "image_generation_user_error"
    ? new AiError.ContentFiltered({
        provider: "openai",
        ...(error.message !== undefined && { reason: error.message }),
        raw,
      })
    : undefined
}

const classify = (body: string, fallback: () => AiError.AiError): Effect.Effect<AiError.AiError> =>
  decodeWireError(body).pipe(
    Effect.map((wire) => moderationOf(wire, body) ?? fallback()),
    Effect.orElseSucceed(fallback),
  )

/** Never fails: the returned error is the value. */
export const imageHttpError = (status: number, body: string): Effect.Effect<AiError.AiError> =>
  classify(body, () => httpStatusError(status, body))

/**
 * An error frame mid-stream. The HTTP status was 200, so the status
 * mapping has nothing to say and a non-moderation failure is one the
 * model hit while generating.
 */
export const imageStreamError = (body: string): Effect.Effect<AiError.AiError> =>
  classify(body, () => new AiError.GenerationFailed({ provider: "openai", raw: body }))

// ---------------------------------------------------------------------------
// Codec - stream frames
// ---------------------------------------------------------------------------

const WirePartialImage = Schema.Struct({
  type: Schema.Literal("image_generation.partial_image"),
  b64_json: Schema.String,
  partial_image_index: Schema.Number,
  output_format: Schema.optional(Schema.String),
})

const WireCompletedImage = Schema.Struct({
  type: Schema.Literal("image_generation.completed"),
  b64_json: Schema.String,
  output_format: Schema.optional(Schema.String),
  usage: Schema.optional(WireUsage),
})

const WireStreamFrame = Schema.Union([WirePartialImage, WireCompletedImage])
type WireStreamFrame = typeof WireStreamFrame.Type

const decodeStreamFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(WireStreamFrame))

const toStreamEvent = (
  wire: WireStreamFrame,
  requested: OpenAIImageKnobs["outputFormat"],
): ImageStreamEvent => {
  const image = imageBase64(wire.b64_json, mimeOf(wire.output_format, requested))
  return wire.type === "image_generation.partial_image"
    ? ImageStreamEvent.PartialImage({ image, index: wire.partial_image_index })
    : ImageStreamEvent.Complete({ images: [{ image }], usage: usageOf(wire.usage) })
}

/**
 * Decode one SSE frame. Frames this capability has no representation for
 * decode to `undefined` and are dropped, so a new event type on the wire
 * does not break the stream.
 */
export const streamEventOf = (
  event: SSE.Event,
  requested: OpenAIImageKnobs["outputFormat"],
): Effect.Effect<ImageStreamEvent | undefined, AiError.AiError> =>
  event.event === "error"
    ? Effect.flatMap(imageStreamError(event.data), Effect.fail)
    : decodeStreamFrame(event.data).pipe(
        Effect.map((wire) => toStreamEvent(wire, requested)),
        Effect.orElseSucceed(() => undefined),
      )

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Generations take JSON, edits take multipart; only the body differs. */
const post = (
  cfg: Config,
  path: string,
  withBody: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientResponse.HttpClientResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client
      .execute(
        HttpClientRequest.post(`${resolveHost(cfg)}${path}`).pipe(
          HttpClientRequest.bearerToken(cfg.apiKey),
          withBody,
        ),
      )
      .pipe(Effect.mapError(transportFailure)),
  )

const failOnStatus = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void, AiError.AiError> =>
  response.status < 400
    ? Effect.void
    : Effect.gen(function* () {
        const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.flatMap(imageHttpError(response.status, body), Effect.fail)
      })

const requestImages = (
  cfg: Config,
  path: string,
  withBody: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  requested: OpenAIImageKnobs["outputFormat"],
): Effect.Effect<ImageResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* post(cfg, path, withBody)
    yield* failOnStatus(response)
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeImagesResponse(json).pipe(Effect.mapError(transportFailure))
    return yield* toResponse(wire, requested)
  })

const generateImpl = (cfg: Config) => (request: OpenAIImageGenerateRequest) =>
  Effect.flatMap(generateBody(request), (body) =>
    requestImages(
      cfg,
      "/images/generations",
      HttpClientRequest.bodyJsonUnsafe(body),
      request.outputFormat,
    ),
  )

const editImpl = (cfg: Config) => (request: OpenAIImageEditRequest) =>
  Effect.flatMap(Effect.flatMap(editForm(request), bodyMultipart), (withBody) =>
    requestImages(cfg, "/images/edits", withBody, request.outputFormat),
  )

/** Both streaming endpoints answer with the same SSE frames. */
const streamFrames = (
  cfg: Config,
  path: string,
  withBody: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  requested: OpenAIImageKnobs["outputFormat"],
): Stream.Stream<ImageStreamEvent, AiError.AiError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // `stream: true` in the body is what OpenAI keys off, but gateways in
      // front of it read the header, so send both like every other
      // streaming adapter here does.
      const response = yield* post(cfg, path, (request) =>
        HttpClientRequest.accept("text/event-stream")(withBody(request)),
      )
      yield* failOnStatus(response)
      return response.stream.pipe(
        Stream.mapError(transportFailure),
        SSE.fromBytes,
        Stream.mapEffect((event) => streamEventOf(event, requested)),
        Stream.filter((event) => event !== undefined),
      )
    }),
  )

const streamImpl = (cfg: Config) => (request: OpenAIStreamImageRequest) =>
  Stream.unwrap(
    Effect.map(streamBody(request), (body) =>
      streamFrames(
        cfg,
        "/images/generations",
        HttpClientRequest.bodyJsonUnsafe(body),
        request.outputFormat,
      ),
    ),
  )

const streamEditImpl = (cfg: Config) => (request: OpenAIStreamImageEditRequest) =>
  Stream.unwrap(
    Effect.map(Effect.flatMap(streamEditForm(request), bodyMultipart), (withBody) =>
      streamFrames(cfg, "/images/edits", withBody, request.outputFormat),
    ),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<OpenAIImageGeneratorService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client): OpenAIImageGeneratorService => ({
    generate: (request) =>
      generateImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    edit: (request) =>
      editImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamGeneration: (request) =>
      streamImpl(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client)),
    streamEdit: (request) =>
      streamEditImpl(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering the provider-typed tag, the generic `ImageGenerator`,
 * and the `ImageStreaming` marker. A `CommonImageGenerateRequest` is
 * structurally an `OpenAIImageGenerateRequest` with no vendor knobs set,
 * so the generic registration forwards directly.
 *
 * `baseUrl` retargets the same wire protocol at an OpenAI-compatible
 * gateway. Whether such a gateway honours partial images is not this
 * Layer's promise; the marker is registered for the models it routes to.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<
  OpenAIImageGenerator | ImageGenerator | ImageStreaming,
  never,
  HttpClient.HttpClient
> =>
  Layer.mergeAll(
    Layer.effect(OpenAIImageGenerator, make(cfg)),
    Layer.effect(
      ImageGenerator,
      Effect.map(make(cfg), (s): ImageGeneratorService => ({
        generate: (request: CommonImageGenerateRequest) =>
          s.generate(request as OpenAIImageGenerateRequest),
        edit: (request: CommonImageEditRequest) => s.edit(request as OpenAIImageEditRequest),
        streamGeneration: (request: CommonStreamImageRequest) =>
          s.streamGeneration(request as OpenAIStreamImageRequest),
        streamEdit: (request: CommonStreamImageEditRequest) =>
          s.streamEdit(request as OpenAIStreamImageEditRequest),
      })),
    ),
    Layer.succeed(ImageStreaming, undefined),
  )
