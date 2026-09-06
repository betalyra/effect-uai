import { Result, Schema } from "effect"
import type {
  AspectRatio,
  Dimensions,
  MediaBase64,
  MediaBytes,
  MediaSource,
  MediaUrl,
  Watermark,
} from "./Media.js"
import { parseAspectRatio, round16 } from "./Media.js"

/**
 * Image MIME types AI providers typically accept. The first four are the
 * universal subset (Cohere v4, Voyage multimodal, Jina v4, Google
 * `gemini-embedding-2`); HEIC / HEIF are Google-specific. The
 * `(string & {})` tail keeps autocomplete on the literals while still
 * accepting any string, so a newly-supported format works without an
 * SDK update.
 */
export type ImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/heic"
  | "image/heif"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

const ImageMimeTypeSchema = Schema.String as unknown as Schema.Schema<ImageMimeType>

export type ImageUrlSource = MediaUrl<ImageMimeType>
export type ImageBase64Source = MediaBase64<ImageMimeType>
export type ImageBytesSource = MediaBytes<ImageMimeType>

/**
 * Where an image lives. Provider layers normalize across these:
 * `bytes` becomes a base64 data URI for OpenAI / Anthropic, an
 * `inlineData` part for Gemini, and a separate field for Cohere /
 * Voyage. URL constraints (must be HTTPS, must be public, …) are
 * provider-specific and validated at the layer, not in the type.
 */
export type ImageSource = MediaSource<ImageMimeType>

export const ImageUrlSource = Schema.TaggedStruct("url", {
  url: Schema.String,
  mimeType: Schema.optional(ImageMimeTypeSchema),
})

export const ImageBase64Source = Schema.TaggedStruct("base64", {
  base64: Schema.String,
  mimeType: ImageMimeTypeSchema,
})

export const ImageBytesSource = Schema.TaggedStruct("bytes", {
  bytes: Schema.Uint8Array,
  mimeType: ImageMimeTypeSchema,
})

export const ImageSource: Schema.Schema<ImageSource> = Schema.Union([
  ImageUrlSource,
  ImageBase64Source,
  ImageBytesSource,
]) as unknown as Schema.Schema<ImageSource>

export const imageUrl = (url: string, mimeType?: ImageMimeType): ImageUrlSource =>
  mimeType !== undefined ? { _tag: "url", url, mimeType } : { _tag: "url", url }

export const imageBase64 = (base64: string, mimeType: ImageMimeType): ImageBase64Source => ({
  _tag: "base64",
  base64,
  mimeType,
})

export const imageBytes = (bytes: Uint8Array, mimeType: ImageMimeType): ImageBytesSource => ({
  _tag: "bytes",
  bytes,
  mimeType,
})

/** Cross-modality; lives in `Media.ts` because video generation shares it. */
export type { AspectRatio, Dimensions } from "./Media.js"

/**
 * Resolution tier, roughly the short edge in pixels. A tier rather than
 * a pixel pair: adapters whose wire takes exact dimensions derive them
 * from the tier and the aspect ratio. Image-typed on purpose, video
 * models tier by scan height instead.
 */
export type ImageResolution = "1K" | "2K" | "4K"

const SHORT_EDGE: Record<ImageResolution, number> = { "1K": 1024, "2K": 2048, "4K": 4096 }

/**
 * Turn the portable ratio and tier into pixels: the tier is the short
 * edge, the long edge follows the ratio. `undefined` when neither was
 * asked for, which the caller sends as "no size" so the endpoint picks.
 *
 * Adapters whose wire wants `"WxH"` format the pair; those wanting an
 * object send it as is. Whether the result is in range for a given model
 * is the server's call: per-model limits churn and we do not table them.
 */
export const pixelsOf = (request: {
  readonly aspectRatio?: AspectRatio
  readonly resolution?: ImageResolution
}): Result.Result<Dimensions | undefined, string> =>
  request.aspectRatio === undefined && request.resolution === undefined
    ? Result.succeed(undefined)
    : Result.map(parseAspectRatio(request.aspectRatio ?? "1:1"), ([w, h]) => {
        const short = SHORT_EDGE[request.resolution ?? "1K"]
        return w >= h
          ? { width: round16((short * w) / h), height: short }
          : { width: short, height: round16((short * h) / w) }
      })

/**
 * Per-image extras a provider reported and this type has no field for:
 * pixel dimensions, a file name, a revised prompt. Opaque here, and a
 * shared slot, so a provider keys its data under its own name
 * (`{ fal: … }`, `{ openai: … }`) and reads only that key. Each provider
 * package ships a typed reader; the framework never interprets it.
 *
 * Not promoted to real fields because the providers disagree on what
 * they report. Only some fal endpoints return dimensions, and neither
 * OpenAI's Images API nor Gemini returns them at all.
 */
export type ProviderData = unknown

/** One image off a generation call, plus what the provider stamped into it. */
export type GeneratedImage = {
  readonly image: ImageSource
  /** Set only when the provider applies one. */
  readonly watermark?: Watermark
  /** {@link ProviderData}: per-image extras, keyed by provider name. */
  readonly providerData?: ProviderData
}

export const isImageUrl = Schema.is(ImageUrlSource)
export const isImageBase64 = Schema.is(ImageBase64Source)
export const isImageBytes = Schema.is(ImageBytesSource)
