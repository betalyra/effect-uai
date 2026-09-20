import { Data, Schema } from "effect"
import type { Duration } from "effect"
import type { ImageSource } from "./Image.js"
import type {
  MediaBase64,
  MediaBytes,
  MediaSource,
  MediaUrl,
  ProviderData,
  Watermark,
} from "./Media.js"

/**
 * Video MIME types video-generation providers return. Every current
 * provider returns `video/mp4`; the rest appear as opt-in output formats
 * (Seedance `mov`, LTX WebM / ProRes). The `(string & {})` tail keeps
 * autocomplete on the literals while accepting any string.
 */
export type VideoMimeType =
  | "video/mp4"
  | "video/webm"
  | "video/quicktime"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

const VideoMimeTypeSchema = Schema.String as unknown as Schema.Schema<VideoMimeType>

export type VideoUrlSource = MediaUrl<VideoMimeType>
export type VideoBase64Source = MediaBase64<VideoMimeType>
export type VideoBytesSource = MediaBytes<VideoMimeType>

/**
 * Where a video lives. Generation providers overwhelmingly return a URL
 * rather than bytes, and those URLs expire (an hour on some providers,
 * thirty days on others), so a caller that needs to keep the video must
 * download it before then.
 */
export type VideoSource = MediaSource<VideoMimeType>

export const VideoUrlSource = Schema.TaggedStruct("url", {
  url: Schema.String,
  mimeType: Schema.optional(VideoMimeTypeSchema),
})

export const VideoBase64Source = Schema.TaggedStruct("base64", {
  base64: Schema.String,
  mimeType: VideoMimeTypeSchema,
})

export const VideoBytesSource = Schema.TaggedStruct("bytes", {
  bytes: Schema.Uint8Array,
  mimeType: VideoMimeTypeSchema,
})

export const VideoSource: Schema.Schema<VideoSource> = Schema.Union([
  VideoUrlSource,
  VideoBase64Source,
  VideoBytesSource,
]) as unknown as Schema.Schema<VideoSource>

export const videoUrl = (url: string, mimeType?: VideoMimeType): VideoUrlSource =>
  mimeType !== undefined ? { _tag: "url", url, mimeType } : { _tag: "url", url }

export const videoBase64 = (base64: string, mimeType: VideoMimeType): VideoBase64Source => ({
  _tag: "base64",
  base64,
  mimeType,
})

export const videoBytes = (bytes: Uint8Array, mimeType: VideoMimeType): VideoBytesSource => ({
  _tag: "bytes",
  bytes,
  mimeType,
})

/** Cross-modality; both live in `Media.ts`. */
export type { AspectRatio, ProviderData } from "./Media.js"

/**
 * Resolution tier, the scan height. Video-typed on purpose: image models
 * tier by short edge (`ImageResolution`), video models by scan height.
 * Spelling varies on the wire (`"768P"`, `"4k"`), so adapters encode.
 */
export type VideoResolution = "360p" | "480p" | "720p" | "1080p" | "4k"

/**
 * A frame or reference fed into a generation alongside the prompt. The
 * role is explicit because it is not inferable: the same image means a
 * different request as a first frame, a last frame or a style reference.
 *
 * Ordered. Dreamina prompts address media positionally (`@Image1`).
 * Providers that cannot honor a variant fail `Unsupported`. Reference
 * video, reference audio and an edit/extend base video are additive
 * variants.
 */
export type VideoInput = Data.TaggedEnum<{
  FirstFrame: { readonly image: ImageSource }
  LastFrame: { readonly image: ImageSource }
  ReferenceImage: { readonly image: ImageSource }
}>

/** Constructors, guards and matchers for {@link VideoInput}. */
export const VideoInput = Data.taggedEnum<VideoInput>()

/** One video off a generation call, plus what the provider stamped into it. */
export type GeneratedVideo = {
  readonly video: VideoSource
  /** Realized duration, where the provider reports it. */
  readonly duration?: Duration.Duration
  readonly width?: number
  readonly height?: number
  readonly fps?: number
  /** Set only when the provider applies one. */
  readonly watermark?: Watermark
  /** {@link ProviderData}: per-video extras, keyed by provider name. */
  readonly providerData?: ProviderData
}

export const isVideoUrl = Schema.is(VideoUrlSource)
export const isVideoBase64 = Schema.is(VideoBase64Source)
export const isVideoBytes = Schema.is(VideoBytesSource)
