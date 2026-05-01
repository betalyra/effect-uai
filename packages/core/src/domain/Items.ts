import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Content blocks (inside Message.content)
// ---------------------------------------------------------------------------

export const InputText = Schema.Struct({
  type: Schema.Literal("input_text"),
  text: Schema.String,
})
export type InputText = typeof InputText.Type

/**
 * Where an image lives. `url` covers HTTP(S) URLs (the model fetches
 * them); `base64` covers inline bytes embedded in the request. Provider
 * encoders dispatch on `_tag`. File-id / uploaded-asset references are
 * provider-specific and stay out of this union for now.
 */
export const ImageUrlSource = Schema.Struct({
  _tag: Schema.Literal("url"),
  url: Schema.String,
})
export type ImageUrlSource = typeof ImageUrlSource.Type

/**
 * Inline image bytes. `data` is **already base64-encoded** (matches what
 * the wire formats expect; no double-encoding needed downstream).
 * `media_type` is the MIME type, e.g. `"image/png"`.
 */
export const ImageBase64Source = Schema.Struct({
  _tag: Schema.Literal("base64"),
  media_type: Schema.String,
  data: Schema.String,
})
export type ImageBase64Source = typeof ImageBase64Source.Type

export const ImageSource = Schema.Union([ImageUrlSource, ImageBase64Source])
export type ImageSource = typeof ImageSource.Type

export const isImageUrlSource = (s: ImageSource): s is ImageUrlSource => s._tag === "url"
export const isImageBase64Source = (s: ImageSource): s is ImageBase64Source =>
  s._tag === "base64"

/**
 * User-provided image content block. Pair with `InputText` inside a
 * `Message.content` array to ask "what's in this image?" style questions.
 */
export const InputImage = Schema.Struct({
  type: Schema.Literal("input_image"),
  source: ImageSource,
})
export type InputImage = typeof InputImage.Type

// ---------------------------------------------------------------------------
// Annotations - source / citation pointers attached to `output_text` blocks.
// Mirrors OpenAI Responses API; other providers can omit or map onto these
// shapes.
// ---------------------------------------------------------------------------

export const UrlCitation = Schema.Struct({
  type: Schema.Literal("url_citation"),
  url: Schema.String,
  start_index: Schema.Number,
  end_index: Schema.Number,
  title: Schema.String,
})
export type UrlCitation = typeof UrlCitation.Type

export const FileCitation = Schema.Struct({
  type: Schema.Literal("file_citation"),
  file_id: Schema.String,
  index: Schema.Number,
})
export type FileCitation = typeof FileCitation.Type

export const ContainerFileCitation = Schema.Struct({
  type: Schema.Literal("container_file_citation"),
  container_id: Schema.String,
  file_id: Schema.String,
  start_index: Schema.Number,
  end_index: Schema.Number,
})
export type ContainerFileCitation = typeof ContainerFileCitation.Type

export const FilePath = Schema.Struct({
  type: Schema.Literal("file_path"),
  file_id: Schema.String,
  index: Schema.Number,
})
export type FilePath = typeof FilePath.Type

export const Annotation = Schema.Union([
  UrlCitation,
  FileCitation,
  ContainerFileCitation,
  FilePath,
])
export type Annotation = typeof Annotation.Type

export const isUrlCitation = (a: Annotation): a is UrlCitation => a.type === "url_citation"
export const isFileCitation = (a: Annotation): a is FileCitation => a.type === "file_citation"
export const isContainerFileCitation = (a: Annotation): a is ContainerFileCitation =>
  a.type === "container_file_citation"
export const isFilePath = (a: Annotation): a is FilePath => a.type === "file_path"

export const OutputText = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String,
  annotations: Schema.optional(Schema.Array(Annotation)),
})
export type OutputText = typeof OutputText.Type

/**
 * Model-emitted refusal. Distinct from `output_text`: the model declined
 * to answer rather than producing normal output. Pair with
 * `stop_reason: "refusal"` on the surrounding `Turn`. Streamed via the
 * `refusal_delta` `TurnEvent`.
 */
export const Refusal = Schema.Struct({
  type: Schema.Literal("refusal"),
  text: Schema.String,
})
export type Refusal = typeof Refusal.Type

export const ContentBlock = Schema.Union([InputText, InputImage, OutputText, Refusal])
export type ContentBlock = typeof ContentBlock.Type

export const Role = Schema.Literals(["user", "assistant", "system"])
export type Role = typeof Role.Type

// ---------------------------------------------------------------------------
// Provider passthrough - every Item type carries this opaque slot.
// The framework never reads or interprets it; provider modules decode
// their own data via their own typed readers (see e.g.
// the `@effect-uai/responses` package).
// ---------------------------------------------------------------------------

const ProviderData = Schema.optional(Schema.Unknown)

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const Message = Schema.Struct({
  type: Schema.Literal("message"),
  role: Role,
  content: Schema.Array(ContentBlock),
  providerData: ProviderData,
})
export type Message = typeof Message.Type

export const FunctionCall = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  // JSON-encoded arguments string, mirroring OpenAI Responses API
  arguments: Schema.String,
  providerData: ProviderData,
})
export type FunctionCall = typeof FunctionCall.Type

export const FunctionCallOutput = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  call_id: Schema.String,
  output: Schema.String,
  providerData: ProviderData,
})
export type FunctionCallOutput = typeof FunctionCallOutput.Type

/**
 * Reasoning item - top-level, mirrors OpenAI Responses API. Common shape
 * across providers covers `summary` (human-readable text) and `signature`
 * (opaque round-trip blob - Anthropic's signed thinking, OpenAI's
 * encrypted_content, etc.). Provider-specific fields go in `providerData`.
 */
export const Reasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  providerData: ProviderData,
})
export type Reasoning = typeof Reasoning.Type

export const Item = Schema.Union([Message, FunctionCall, FunctionCallOutput, Reasoning])
export type Item = typeof Item.Type

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export const isInputText = (block: ContentBlock): block is InputText => block.type === "input_text"
export const isInputImage = (block: ContentBlock): block is InputImage =>
  block.type === "input_image"
export const isOutputText = (block: ContentBlock): block is OutputText =>
  block.type === "output_text"
export const isRefusal = (block: ContentBlock): block is Refusal => block.type === "refusal"

export const isMessage = (item: Item): item is Message => item.type === "message"
export const isFunctionCall = (item: Item): item is FunctionCall => item.type === "function_call"
export const isFunctionCallOutput = (item: Item): item is FunctionCallOutput =>
  item.type === "function_call_output"
export const isReasoning = (item: Item): item is Reasoning => item.type === "reasoning"

// ---------------------------------------------------------------------------
// Usage and stop reason
// ---------------------------------------------------------------------------

export const InputTokensDetails = Schema.Struct({
  cached_tokens: Schema.optional(Schema.Number),
})
export type InputTokensDetails = typeof InputTokensDetails.Type

export const OutputTokensDetails = Schema.Struct({
  reasoning_tokens: Schema.optional(Schema.Number),
})
export type OutputTokensDetails = typeof OutputTokensDetails.Type

export const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  input_tokens_details: Schema.optional(InputTokensDetails),
  output_tokens_details: Schema.optional(OutputTokensDetails),
})
export type Usage = typeof Usage.Type

export const StopReason = Schema.Literals(["stop", "tool_calls", "max_tokens", "refusal"])
export type StopReason = typeof StopReason.Type

// ---------------------------------------------------------------------------
// Helper constructors
// ---------------------------------------------------------------------------

export const userText = (text: string): Message => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
})

export const systemText = (text: string): Message => ({
  type: "message",
  role: "system",
  content: [{ type: "input_text", text }],
})

export const assistantText = (text: string): Message => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
})

export const functionCallOutput = (call_id: string, output: string): FunctionCallOutput => ({
  type: "function_call_output",
  call_id,
  output,
})
