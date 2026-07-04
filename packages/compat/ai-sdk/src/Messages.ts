/**
 * Decode the `messages` array a `useChat` client POSTs (Vercel's `UIMessage`
 * shape) back into effect-uai `HistoryItem`s, so an existing loop can run
 * against an unchanged frontend.
 *
 * One `UIMessage` can expand to several history items: an assistant message
 * carrying tool calls becomes an assistant `Message` followed by the
 * `ToolCall` / `ToolCallOutput` items the model needs to see. Text and image
 * (`file` with an `image/*` media type) parts fold into a message's content;
 * non-image files and unresolved tool states are dropped.
 */
import * as Image from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import { Match, Schema } from "effect"

// The inbound part variants we understand. Tool parts are identified
// structurally by `toolCallId` - their wire `type` is a dynamic `tool-<name>`
// (or `dynamic-tool`) rather than a fixed literal - so their schema keeps
// `type` open and reads the name off it.
const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})
export type TextPart = typeof TextPart.Type

const FilePart = Schema.Struct({
  type: Schema.Literal("file"),
  mediaType: Schema.String,
  url: Schema.String,
})
export type FilePart = typeof FilePart.Type

const ToolPart = Schema.Struct({
  type: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
})
export type ToolPart = typeof ToolPart.Type

const isText = Schema.is(TextPart)
const isFile = Schema.is(FilePart)
const isTool = Schema.is(ToolPart)
const isImageFile = (part: FilePart): boolean => part.mediaType.startsWith("image")

// A raw inbound part: a discriminating `type` plus whatever else the client
// attached. Kept open so the schema guards do the narrowing.
export type UIPart = {
  readonly type: string
  readonly [key: string]: unknown
}

export type UIMessage = {
  readonly id?: string
  readonly role: "user" | "assistant" | "system"
  readonly parts: ReadonlyArray<UIPart>
}

const textOf = (message: UIMessage): string =>
  message.parts
    .filter(isText)
    .map((part) => part.text)
    .join("")

const imageBlocks = (message: UIMessage): ReadonlyArray<Items.InputImage> =>
  message.parts
    .filter(isFile)
    .filter(isImageFile)
    .map((part) => ({ type: "input_image", source: Image.imageUrl(part.url, part.mediaType) }))

// A user turn: one joined text block (if any) followed by one image block per
// image file, preserving the model's expectation of text-then-media.
const userMessage = (message: UIMessage): Items.Message => {
  const text = textOf(message)
  return {
    type: "message",
    role: "user",
    content: [
      ...(text.length > 0 ? [{ type: "input_text", text } as const] : []),
      ...imageBlocks(message),
    ],
  }
}

const toolName = (part: ToolPart): string =>
  part.type === "dynamic-tool" ? (part.toolName ?? "") : part.type.slice("tool-".length)

// A resolved tool call becomes a `function_call` item, plus a
// `function_call_output` once the client carries its output.
const toolItems = (part: ToolPart): ReadonlyArray<Items.HistoryItem> => {
  const call: Items.ToolCall = {
    type: "function_call",
    call_id: part.toolCallId,
    name: toolName(part),
    arguments: JSON.stringify(part.input ?? {}),
  }
  if (part.state !== "output-available") return [call]
  const output = typeof part.output === "string" ? part.output : JSON.stringify(part.output)
  return [call, Items.toolCallOutput(part.toolCallId, output)]
}

const assistantItems = (message: UIMessage): ReadonlyArray<Items.HistoryItem> => {
  const text = textOf(message)
  return [
    ...(text.length > 0 ? [Items.assistantText(text)] : []),
    ...message.parts.filter(isTool).flatMap(toolItems),
  ]
}

const decodeMessage = (message: UIMessage): ReadonlyArray<Items.HistoryItem> =>
  Match.value(message.role).pipe(
    Match.when("user", () => [userMessage(message)]),
    Match.when("system", () => [Items.systemText(textOf(message))]),
    Match.when("assistant", () => assistantItems(message)),
    Match.exhaustive,
  )

export const decodeMessages = (
  messages: ReadonlyArray<UIMessage>,
): ReadonlyArray<Items.HistoryItem> => messages.flatMap(decodeMessage)
