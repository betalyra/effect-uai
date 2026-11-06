import { Schema } from "effect"
import type { MediaBase64, MediaBytes, MediaSource, MediaUrl } from "./Media.js"

/**
 * MIME types of files a user hands to a model: documents, audio, video. The
 * listed ones are common; the `(string & {})` tail accepts any other, so a
 * newly supported format works without an SDK update. Which types a model
 * reads is the provider's call: an unsupported one is rejected by the
 * provider, not converted here.
 */
export type FileMimeType =
  | "application/pdf"
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "text/html"
  | "application/json"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "audio/mpeg"
  | "audio/wav"
  | "video/mp4"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

const FileMimeTypeSchema: Schema.Codec<FileMimeType> = Schema.String

export type FileUrlSource = MediaUrl<FileMimeType>
export type FileBase64Source = MediaBase64<FileMimeType>
export type FileBytesSource = MediaBytes<FileMimeType>

/** Where a file lives: a URL the model fetches, inline base64, or raw bytes. */
export type FileSource = MediaSource<FileMimeType>

export const FileUrlSource = Schema.TaggedStruct("url", {
  url: Schema.String,
  mimeType: Schema.optionalKey(FileMimeTypeSchema),
})

export const FileBase64Source = Schema.TaggedStruct("base64", {
  base64: Schema.String,
  mimeType: FileMimeTypeSchema,
})

export const FileBytesSource = Schema.TaggedStruct("bytes", {
  bytes: Schema.Uint8Array,
  mimeType: FileMimeTypeSchema,
})

export const FileSource: Schema.Codec<FileSource> = Schema.Union([
  FileUrlSource,
  FileBase64Source,
  FileBytesSource,
])

export const fileUrl = (url: string, mimeType?: FileMimeType): FileUrlSource =>
  mimeType !== undefined ? { _tag: "url", url, mimeType } : { _tag: "url", url }

export const fileBase64 = (base64: string, mimeType: FileMimeType): FileBase64Source => ({
  _tag: "base64",
  base64,
  mimeType,
})

export const fileBytes = (bytes: Uint8Array, mimeType: FileMimeType): FileBytesSource => ({
  _tag: "bytes",
  bytes,
  mimeType,
})
