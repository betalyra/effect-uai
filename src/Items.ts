import { Schema } from "effect"

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

export const Message = Schema.Struct({
  type: Schema.Literal("message"),
  role: Role,
  content: Schema.Array(ContentBlock)
})
export type Message = typeof Message.Type

export const FunctionCall = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  // JSON-encoded arguments string, mirroring OpenAI Responses API
  arguments: Schema.String
})
export type FunctionCall = typeof FunctionCall.Type

export const FunctionCallOutput = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  call_id: Schema.String,
  output: Schema.String
})
export type FunctionCallOutput = typeof FunctionCallOutput.Type

export const Item = Schema.Union([Message, FunctionCall, FunctionCallOutput])
export type Item = typeof Item.Type

export const Usage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  total_tokens: Schema.Number
})
export type Usage = typeof Usage.Type

export const StopReason = Schema.Literals(["stop", "tool_calls", "max_tokens"])
export type StopReason = typeof StopReason.Type

// Helper constructors
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
