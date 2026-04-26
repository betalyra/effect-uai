import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Content blocks (inside Message.content)
// ---------------------------------------------------------------------------

export const InputText = Schema.Struct({
  type: Schema.Literal("input_text"),
  text: Schema.String
})
export type InputText = typeof InputText.Type

export const OutputText = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String
})
export type OutputText = typeof OutputText.Type

export const ContentBlock = Schema.Union([InputText, OutputText])
export type ContentBlock = typeof ContentBlock.Type

export const Role = Schema.Literals(["user", "assistant", "system"])
export type Role = typeof Role.Type

// ---------------------------------------------------------------------------
// Provider passthrough — every Item type carries this opaque slot.
// The framework never reads or interprets it; provider modules decode
// their own data via their own typed readers (see e.g.
// `src/providers/openai/Reasoning.ts`).
// ---------------------------------------------------------------------------

const ProviderData = Schema.optional(Schema.Unknown)

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const Message = Schema.Struct({
  type: Schema.Literal("message"),
  role: Role,
  content: Schema.Array(ContentBlock),
  providerData: ProviderData
})
export type Message = typeof Message.Type

export const FunctionCall = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  // JSON-encoded arguments string, mirroring OpenAI Responses API
  arguments: Schema.String,
  providerData: ProviderData
})
export type FunctionCall = typeof FunctionCall.Type

export const FunctionCallOutput = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  call_id: Schema.String,
  output: Schema.String,
  providerData: ProviderData
})
export type FunctionCallOutput = typeof FunctionCallOutput.Type

/**
 * Reasoning item — top-level, mirrors OpenAI Responses API. Common shape
 * across providers covers `summary` (human-readable text) and `signature`
 * (opaque round-trip blob — Anthropic's signed thinking, OpenAI's
 * encrypted_content, etc.). Provider-specific fields go in `providerData`.
 */
export const Reasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  providerData: ProviderData
})
export type Reasoning = typeof Reasoning.Type

export const Item = Schema.Union([
  Message,
  FunctionCall,
  FunctionCallOutput,
  Reasoning
])
export type Item = typeof Item.Type

// ---------------------------------------------------------------------------
// Usage and stop reason
// ---------------------------------------------------------------------------

export const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number)
})
export type Usage = typeof Usage.Type

export const StopReason = Schema.Literals(["stop", "tool_calls", "max_tokens"])
export type StopReason = typeof StopReason.Type

// ---------------------------------------------------------------------------
// Helper constructors
// ---------------------------------------------------------------------------

export const userText = (text: string): Message => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }]
})

export const systemText = (text: string): Message => ({
  type: "message",
  role: "system",
  content: [{ type: "input_text", text }]
})

export const assistantText = (text: string): Message => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }]
})

export const functionCallOutput = (
  call_id: string,
  output: string
): FunctionCallOutput => ({
  type: "function_call_output",
  call_id,
  output
})
