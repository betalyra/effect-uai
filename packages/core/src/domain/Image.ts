import { Schema } from "effect"
import type { MediaBase64, MediaBytes, MediaSource, MediaUrl, Watermark } from "./Media.js"

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
export type { AspectRatio } from "./Media.js"

/**
 * Resolution tier, roughly the short edge in pixels. A tier rather than
 * a pixel pair: adapters whose wire takes exact dimensions derive them
 * from the tier and the aspect ratio. Image-typed on purpose, video
 * models tier by scan height instead.
 */
export type ImageResolution = "1K" | "2K" | "4K"

/** One image off a generation call, plus what the provider stamped into it. */
export type GeneratedImage = {
  readonly image: ImageSource
  /** Set only when the provider applies one. */
  readonly watermark?: Watermark
}

export const isImageUrl = Schema.is(ImageUrlSource)
export const isImageBase64 = Schema.is(ImageBase64Source)
export const isImageBytes = Schema.is(ImageBytesSource)
