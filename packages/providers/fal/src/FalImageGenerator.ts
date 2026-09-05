import {
  Context,
  Effect,
  Encoding,
  Layer,
  Match,
  Option,
  Redacted,
  Ref,
  Result,
  Schema,
  Stream,
  pipe,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import type { GeneratedImage, ImageSource } from "@effect-uai/core/Image"
import { imageBase64, imageUrl, pixelsOf } from "@effect-uai/core/Image"
import type {
  CommonImageEditRequest,
  CommonImageGenerateRequest,
  CommonStreamImageEditRequest,
  CommonStreamImageRequest,
  ImageGeneratorService,
  ImageResponse,
  ImageStreamEvent,
} from "@effect-uai/core/ImageGenerator"
import { ImageGenerator } from "@effect-uai/core/ImageGenerator"
import { PROVIDER, httpError, missingImageField, transportFailure } from "./codec.js"
import type { FalImageEditModel, FalImageModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A named preset (`"landscape_4_3"`, `"auto_2K"`, …) or exact pixels. */
export type FalImageSize = string | { readonly width: number; readonly height: number }

/**
 * Wire knobs shared by most fal image endpoints. fal is not one API but a
 * catalogue of models behind one envelope, so only `prompt`, `num_images`
 * and the output envelope are dependable across all of them; the fields
 * here are the ones the image endpoints agree on.
 */
type FalImageKnobs = {
  /** Sent as `image_size`. Takes precedence over the portable ratio and tier. */
  readonly imageSize?: FalImageSize
  readonly seed?: number
  readonly outputFormat?: "jpeg" | "png" | "webp"
  /** Diffusion knobs, open-weights models only. */
  readonly numInferenceSteps?: number
  readonly guidanceScale?: number
  readonly enableSafetyChecker?: boolean
  /**
   * `false` returns fal CDN links instead of inline bytes. The default is
   * `true`: every other adapter here hands back bytes, and fal's links
   * expire.
   */
  readonly syncMode?: boolean
  /**
   * Fields only one endpoint takes: `acceleration`, `loras`,
   * `safety_tolerance`, `thinking_level`, `aspect_ratio`. Merged last, so
   * it also overrides anything derived above. Snake case, as the wire
   * spells it. The escape hatch exists because fal's schemas are
   * per-model and tabling them would go stale in a week.
   */
  readonly input?: Record<string, unknown>
}

export type FalImageGenerateRequest = Omit<CommonImageGenerateRequest, "model"> & {
  readonly model: FalImageModel
} & FalImageKnobs

export type FalImageEditRequest = Omit<CommonImageEditRequest, "model"> & {
  /** Edit is a *different endpoint* on fal, not a flag on the same one. */
  readonly model: FalImageEditModel
} & FalImageKnobs

export type FalImageGeneratorService = {
  readonly generate: (
    request: FalImageGenerateRequest,
  ) => Effect.Effect<ImageResponse, AiError.AiError>
  readonly edit: (request: FalImageEditRequest) => Effect.Effect<ImageResponse, AiError.AiError>
  /** Both always `Unsupported`: `ImageStreaming` is not registered by {@link layer}. */
  readonly streamGeneration: ImageGeneratorService["streamGeneration"]
  readonly streamEdit: ImageGeneratorService["streamEdit"]
}

/**
 * Provider-typed service tag. Yield this for exact pixel sizes, seeds,
 * diffusion knobs and the per-endpoint `input` passthrough; yield the
 * generic `ImageGenerator` tag for provider-portable code. Both are
 * registered by {@link layer}.
 */
export class FalImageGenerator extends Context.Service<
  FalImageGenerator,
  FalImageGeneratorService
>()("@betalyra/effect-uai/providers/fal/FalImageGenerator") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - size
//
// The portable request carries a ratio and a tier; fal endpoints take
// `image_size`, either a named preset or `{ width, height }`. Pixels are
// derived because the preset names differ per model family while the
// object form is the shape they share.
// ---------------------------------------------------------------------------

/**
 * The typed `imageSize` wins over the portable pair, which is then
 * dropped. `undefined` means "send no size" and let the endpoint pick.
 */
export const imageSizeOf = (
  request: Pick<FalImageGenerateRequest, "imageSize" | "aspectRatio" | "resolution">,
): Effect.Effect<FalImageSize | undefined, AiError.AiError> =>
  Effect.gen(function* () {
    if (request.imageSize !== undefined) {
      const overridden = "`imageSize` sets the dimensions directly."
      yield* Capabilities.warnDroppedWhen(request.aspectRatio, {
        provider: PROVIDER,
        capability: "aspectRatio",
        field: "aspectRatio",
        reason: overridden,
      })
      yield* Capabilities.warnDroppedWhen(request.resolution, {
        provider: PROVIDER,
        capability: "resolution",
        field: "resolution",
        reason: overridden,
      })
      return request.imageSize
    }
    return yield* Result.match(pixelsOf(request), {
      onSuccess: Effect.succeed<FalImageSize | undefined>,
      onFailure: (reason) =>
        Effect.fail(
          new AiError.InvalidRequest({
            provider: PROVIDER,
            param: "aspectRatio",
            raw: `${reason} Set \`imageSize\` directly to bypass the derivation.`,
          }),
        ),
    })
  })

// ---------------------------------------------------------------------------
// Codec - request
// ---------------------------------------------------------------------------

/**
 * fal reads reference images from URLs, and a data URI is a URL, so
 * every `ImageSource` has a wire form here. This is the one adapter
 * where passing a `url` reference costs nothing.
 */
const referenceUrl: (image: ImageSource) => string = Match.type<ImageSource>().pipe(
  Match.tag("url", (i) => i.url),
  Match.tag("base64", (i) => `data:${i.mimeType};base64,${i.base64}`),
  Match.tag("bytes", (i) => `data:${i.mimeType};base64,${Encoding.encodeBase64(i.bytes)}`),
  Match.exhaustive,
)

/**
 * Which wire field an endpoint reads references from.
 *
 * Every current flagship edit endpoint converged on `image_urls`, across
 * vendors: `fal-ai/flux-2-pro/edit`, `bytedance/seedream/v5/pro/edit`,
 * `alibaba/qwen-image-3/edit`, `fal-ai/nano-banana-2/edit` and
 * `openai/gpt-image-2/edit` all take the array. So the default is right
 * for the models anyone reaches for, and the table below is the older
 * single-image generation that predates the convention.
 *
 * The owner namespace does *not* predict this: all four spellings we
 * found live under `fal-ai/`. Only the endpoint does.
 */
const DEFAULT_REFERENCE_FIELD = "image_urls"

const KNOWN_REFERENCE_FIELD: Record<string, string> = {
  "fal-ai/qwen-image-edit": "image_url",
  "fal-ai/flux/dev/image-to-image": "image_url",
  "fal-ai/flux-lora/image-to-image": "image_url",
  "fal-ai/image-editing/professional-photo": "image_url",
  "fal-ai/uso": "input_image_urls",
}

/** `_urls` takes the set, `_url` takes one. True of every spelling fal uses. */
const takesMany = (field: string): boolean => field.endsWith("_urls")

/**
 * References under the field the endpoint reads. A single-image field
 * gets the last reference rather than the first: callers pass anchors
 * before the image being changed, so the last is the one meant.
 */
const referenceFields = (
  images: ReadonlyArray<ImageSource>,
  field: string,
): Record<string, unknown> => {
  const last = images[images.length - 1]
  return images.length === 0 || last === undefined
    ? {}
    : takesMany(field)
      ? { [field]: images.map(referenceUrl) }
      : { [field]: referenceUrl(last) }
}

export type WireBody = Record<string, unknown> & {
  readonly prompt: string
}

export const buildBody = (
  request: FalImageGenerateRequest,
  images: ReadonlyArray<ImageSource>,
  field: string = DEFAULT_REFERENCE_FIELD,
): Effect.Effect<WireBody, AiError.AiError> =>
  Effect.gen(function* () {
    const imageSize = yield* imageSizeOf(request)
    const references = referenceFields(images, field)
    return {
      prompt: request.prompt,
      // Inline bytes rather than an expiring CDN link, unless asked otherwise.
      sync_mode: request.syncMode ?? true,
      ...(imageSize !== undefined && { image_size: imageSize }),
      ...(request.n !== undefined && { num_images: request.n }),
      ...(request.seed !== undefined && { seed: request.seed }),
      ...(request.outputFormat !== undefined && { output_format: request.outputFormat }),
      ...(request.numInferenceSteps !== undefined && {
        num_inference_steps: request.numInferenceSteps,
      }),
      ...(request.guidanceScale !== undefined && { guidance_scale: request.guidanceScale }),
      ...(request.enableSafetyChecker !== undefined && {
        enable_safety_checker: request.enableSafetyChecker,
      }),
      ...references,
      ...request.input,
    }
  })

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

/**
 * Only what is read. fal's per-model schemas carry `width`, `height`,
 * `file_name` and `file_size` too, and declare every one of them
 * *nullable*: an endpoint that has nothing to say sends `null` rather
 * than omitting the key. Declaring a field we never use is a decode
 * failure waiting for the first endpoint that leaves it empty.
 */
const ImageFile = Schema.Struct({
  url: Schema.String,
  content_type: Schema.optional(Schema.NullOr(Schema.String)),
})
type ImageFile = typeof ImageFile.Type

/** A handful of endpoints return `image` singular; the rest return `images`. */
const Wire = Schema.Struct({
  images: Schema.optional(Schema.NullOr(Schema.Array(ImageFile))),
  image: Schema.optional(Schema.NullOr(ImageFile)),
  has_nsfw_concepts: Schema.optional(Schema.NullOr(Schema.Array(Schema.Boolean))),
})
type Wire = typeof Wire.Type

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Wire))

/**
 * Decode from the raw body rather than parsed JSON, so a shape this
 * adapter cannot read comes back with the body attached. Output schemas
 * are per-model here, and "we could not read it" is unactionable without
 * the thing we could not read.
 */
export const decodeWire = (body: string): Effect.Effect<Wire, AiError.AiError> =>
  decodeBody(body).pipe(
    Effect.mapError(
      () =>
        new AiError.GenerationFailed({
          provider: PROVIDER,
          message: "fal returned a body with no readable image field.",
          // `sync_mode` puts a whole image in the body, so the head is
          // what gets attached: enough to see the shape, not megabytes.
          raw: body.length > 2000 ? `${body.slice(0, 2000)}… (${body.length} bytes)` : body,
        }),
    ),
  )

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s

/** `sync_mode` returns a data URI; without it, a link that expires. */
const dataUri = (url: string): Option.Option<readonly [string, string]> =>
  pipe(
    Option.fromNullOr(DATA_URI.exec(url)),
    Option.flatMap(([, mimeType, base64]) =>
      mimeType !== undefined && base64 !== undefined
        ? Option.some([mimeType, base64] as const)
        : Option.none(),
    ),
  )

/** No fal image model documents a watermark, so none is claimed. */
const generatedImage = (file: ImageFile): GeneratedImage => ({
  image: Option.match(dataUri(file.url), {
    onNone: () => imageUrl(file.url, file.content_type ?? undefined),
    onSome: ([mimeType, base64]) => imageBase64(base64, mimeType),
  }),
})

/** Every image flagged means nothing usable came back, which is a refusal. */
const refused = (wire: Wire): boolean => {
  const flags = wire.has_nsfw_concepts ?? []
  return flags.length > 0 && flags.every((flagged) => flagged)
}

export const toResponse = (wire: Wire): Effect.Effect<ImageResponse, AiError.AiError> => {
  const files = [...(wire.images ?? []), ...(wire.image == null ? [] : [wire.image])]
  if (refused(wire)) {
    return Effect.fail(
      new AiError.ContentFiltered({
        provider: PROVIDER,
        reason: "The safety checker flagged every generated image.",
        raw: wire,
      }),
    )
  }
  // fal bills per image and per megapixel, not per token, so there is no
  // usage to report.
  return files.length === 0
    ? Effect.fail(
        new AiError.GenerationFailed({
          provider: PROVIDER,
          message: "fal returned no image.",
          raw: wire,
        }),
      )
    : Effect.succeed({ images: files.map(generatedImage), usage: {} })
}

// ---------------------------------------------------------------------------
// HTTP
//
// The synchronous endpoint: one request, one response. The queue API
// (`queue.fal.run`) exists for jobs long enough to outlive a connection,
// which image generation is not.
// ---------------------------------------------------------------------------

const host = (cfg: Config): string => cfg.baseUrl ?? "https://fal.run"

type Attempt = { readonly status: number; readonly body: string }

const attempt = (
  cfg: Config,
  model: string,
  request: FalImageGenerateRequest,
  images: ReadonlyArray<ImageSource>,
  field: string,
): Effect.Effect<Attempt, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* buildBody(request, images, field)
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${host(cfg)}/${model}`).pipe(
          HttpClientRequest.setHeader("authorization", `Key ${Redacted.value(cfg.apiKey)}`),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.mapError(transportFailure))
    const text = yield* response.text.pipe(Effect.mapError(transportFailure))
    return { status: response.status, body: text }
  })

const finish = (attempt: Attempt): Effect.Effect<ImageResponse, AiError.AiError> =>
  attempt.status >= 400
    ? Effect.flatMap(httpError(attempt.status, attempt.body), Effect.fail)
    : Effect.flatMap(decodeWire(attempt.body), toResponse)

/**
 * `learned` remembers what an endpoint asked for, so only the first call
 * to one this adapter has no mapping for pays for the correction. The
 * retry is free of inference cost: fal validates before it runs anything.
 */
const requestImages = (
  cfg: Config,
  model: string,
  request: FalImageGenerateRequest,
  images: ReadonlyArray<ImageSource>,
  learned: Ref.Ref<Record<string, string>>,
): Effect.Effect<ImageResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const remembered = yield* Ref.get(learned)
    const field = remembered[model] ?? KNOWN_REFERENCE_FIELD[model] ?? DEFAULT_REFERENCE_FIELD
    const first = yield* attempt(cfg, model, request, images, field)
    if (first.status < 400 || images.length === 0) return yield* finish(first)

    const asked = yield* Effect.map(missingImageField(first.body), (name) =>
      Option.flatMap(name, (wanted) =>
        wanted === field ? Option.none<string>() : Option.some(wanted),
      ),
    )
    if (Option.isNone(asked)) return yield* finish(first)

    yield* Ref.update(learned, (known) => ({ ...known, [model]: asked.value }))
    return yield* Effect.flatMap(attempt(cfg, model, request, images, asked.value), finish)
  })

/**
 * fal's `/stream` endpoint exists, but the events it carries are defined
 * by each model rather than by fal, and no image endpoint documents
 * partial images. {@link layer} therefore does not register
 * `ImageStreaming`, and calling the top-level `streamGeneration` helper
 * against this Layer alone fails to typecheck; this branch covers the
 * service being used directly.
 */
const streamUnsupported = (capability: string): Stream.Stream<ImageStreamEvent, AiError.AiError> =>
  Stream.fail(
    new AiError.Unsupported({
      provider: PROVIDER,
      capability,
      reason:
        "No fal image endpoint documents a partial-image stream. Use `generate` or `edit` and render when it resolves.",
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<FalImageGeneratorService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const learned = yield* Ref.make<Record<string, string>>({})
    return {
      generate: (request) =>
        requestImages(cfg, request.model, request, [], learned).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      edit: (request) =>
        requestImages(cfg, request.model, request, request.images, learned).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      streamGeneration: () => streamUnsupported("streamGeneration"),
      streamEdit: () => streamUnsupported("streamEdit"),
    }
  })

/**
 * Layer registering the provider-typed tag and the generic
 * `ImageGenerator`. A `CommonImageGenerateRequest` is structurally a
 * `FalImageGenerateRequest` with no vendor knobs set, so the generic
 * registration forwards directly.
 *
 * Does NOT register `ImageStreaming`.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<FalImageGenerator | ImageGenerator, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(FalImageGenerator, make(cfg)),
    Layer.effect(
      ImageGenerator,
      Effect.map(make(cfg), (s): ImageGeneratorService => ({
        generate: (request: CommonImageGenerateRequest) =>
          s.generate(request as FalImageGenerateRequest),
        edit: (request: CommonImageEditRequest) => s.edit(request as FalImageEditRequest),
        streamGeneration: (_request: CommonStreamImageRequest) =>
          streamUnsupported("streamGeneration"),
        streamEdit: (_request: CommonStreamImageEditRequest) => streamUnsupported("streamEdit"),
      })),
    ),
  )
