/**
 * What a tool's `run` may return without an `outputSchema`. Plain values stay
 * plain (a string is text, anything else JSON); only media is marked, by class,
 * so it is told apart from JSON by `instanceof`, never by shape.
 */
import { Schema } from "effect"
import { type FileSource, FileSourceJson } from "../domain/File.js"
import { type ImageSource, ImageSourceJson } from "../domain/Image.js"

export class Image extends Schema.TaggedClass<Image>()("Image", { source: ImageSourceJson }) {}

export class File extends Schema.TaggedClass<File>()("File", {
  source: FileSourceJson,
  filename: Schema.optionalKey(Schema.String),
}) {}

export const Media = Schema.Union([Image, File])
export type Media = typeof Media.Type

export const image = (source: ImageSource): Image => new Image({ source })

export const file = (source: FileSource, filename?: string): File =>
  new File(filename === undefined ? { source } : { source, filename })

export const isMedia = (u: unknown): u is Media => u instanceof Image || u instanceof File

/**
 * Text, JSON, one medium, or a top-level array mixing JSON and media. Encodes to
 * JSON (bytes as base64), so it also serves as the UI codec for tools without
 * an `outputSchema`.
 */
export const Value = Schema.Union([
  Schema.String,
  Media,
  Schema.Array(Schema.Union([Media, Schema.Json])),
  Schema.Json,
])
export type Value = typeof Value.Type
