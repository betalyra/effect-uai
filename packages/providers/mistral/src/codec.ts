import { Array as Arr, Effect, Encoding, Match, Option } from "effect"
import type { ContentBlock, HistoryItem, InputImage } from "@effect-uai/core/Items"

// The streaming decoder, tool encoding, and terminal-turn assembly are the
// generic OpenAI chat-completions codec: Mistral speaks that dialect on the
// wire, so it reuses them verbatim. Only request encoding diverges (below).
export {
  type Accumulator,
  type WireChunk,
  accumulatorToTurn,
  applyChunk,
  emptyAccumulator,
  responseFormatWire,
  toolsWire,
} from "@effect-uai/chat-completions/codec"
import {
  type WireChunk,
  decodeChunk as decodeChunkShared,
} from "@effect-uai/chat-completions/codec"

// ---------------------------------------------------------------------------
// History → Mistral chat `messages`
//
// Same shape as the generic codec, with one wire quirk: Mistral takes a bare
// `image_url` string, not OpenAI's `image_url: { url }` object. That is the
// reason this half stays local rather than importing `itemsToMessages`.
// ---------------------------------------------------------------------------

type WireMessage = {
  role: string
  content: string | ReadonlyArray<Record<string, unknown>>
  tool_calls?: ReadonlyArray<Record<string, unknown>>
  tool_call_id?: string
}

/** A `data:` URI for inline image bytes; URLs pass through untouched. */
const imageSourceToUrl = Match.type<InputImage["source"]>().pipe(
  Match.tag("url", (s) => s.url),
  Match.tag("base64", (s) => `data:${s.mimeType};base64,${s.base64}`),
  Match.tag("bytes", (s) => `data:${s.mimeType};base64,${Encoding.encodeBase64(s.bytes)}`),
  Match.exhaustive,
)

const blockToPart = Match.type<ContentBlock>().pipe(
  Match.discriminatorsExhaustive("type")({
    input_text: (b) => ({ type: "text", text: b.text }),
    output_text: (b) => ({ type: "text", text: b.text }),
    refusal: (b) => ({ type: "text", text: b.text }),
    // Bare string, not `{ url }`: the Mistral divergence from OpenAI.
    input_image: (b) => ({ type: "image_url", image_url: imageSourceToUrl(b.source) }),
  }),
)

const isTextBlock = (b: ContentBlock): boolean =>
  b.type === "input_text" || b.type === "output_text" || b.type === "refusal"

const textOfBlock = (b: ContentBlock): string => (b.type === "input_image" ? "" : b.text)

/**
 * Collapse a message's content to a plain string when it is text-only
 * (the common case Mistral prefers), otherwise emit the multimodal parts
 * array.
 */
const encodeContent = (
  content: ReadonlyArray<ContentBlock>,
): string | ReadonlyArray<Record<string, unknown>> =>
  Arr.every(content, isTextBlock) ? content.map(textOfBlock).join("") : content.map(blockToPart)

const toolCallWire = (call_id: string, name: string, args: string): Record<string, unknown> => ({
  id: call_id,
  type: "function",
  function: { name, arguments: args },
})

const appendToolCall = (
  acc: ReadonlyArray<WireMessage>,
  call_id: string,
  name: string,
  args: string,
): ReadonlyArray<WireMessage> => {
  const last = acc[acc.length - 1]
  const wire = toolCallWire(call_id, name, args)
  // Attach to the immediately-preceding assistant message (not a tool result),
  // matching the OpenAI/Mistral shape where tool calls ride the assistant turn.
  if (last !== undefined && last.role === "assistant" && last.tool_call_id === undefined) {
    return [...acc.slice(0, -1), { ...last, tool_calls: [...(last.tool_calls ?? []), wire] }]
  }
  return [...acc, { role: "assistant", content: "", tool_calls: [wire] }]
}

const foldItem = (acc: ReadonlyArray<WireMessage>, item: HistoryItem): ReadonlyArray<WireMessage> =>
  Match.value(item).pipe(
    Match.discriminatorsExhaustive("type")({
      message: (m) => [...acc, { role: m.role, content: encodeContent(m.content) }],
      function_call: (f) => appendToolCall(acc, f.call_id, f.name, f.arguments),
      function_call_output: (o) => [
        ...acc,
        { role: "tool", tool_call_id: o.call_id, content: o.output },
      ],
      // Reasoning items are not replayed to the chat-completions endpoint.
      reasoning: () => acc,
    }),
  )

/** Convert our `HistoryItem[]` history into Mistral chat `messages`. */
export const itemsToMessages = (items: ReadonlyArray<HistoryItem>): ReadonlyArray<WireMessage> =>
  Arr.reduce(items, [] as ReadonlyArray<WireMessage>, foldItem)

// ---------------------------------------------------------------------------
// tool_choice
// ---------------------------------------------------------------------------

type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { readonly type: "function"; readonly name: string }

// Mistral uses "any" for forced tool use (OpenAI's "required").
export const toolChoiceWire = (choice: ToolChoice): string | Record<string, unknown> =>
  Match.value(choice).pipe(
    Match.when("auto", () => "auto" as const),
    Match.when("required", () => "any" as const),
    Match.when("none", () => "none" as const),
    Match.orElse((c) => ({ type: "function", function: { name: c.name } })),
  )

// ---------------------------------------------------------------------------
// Streaming decode
// ---------------------------------------------------------------------------

// Mistral emits `model_length` when it truncates on the context window; the
// shared decoder only knows OpenAI's `length`. Rewrite it before folding so the
// shared accumulator maps it to `max_tokens` rather than the `stop` fallback.
const normalizeChunk = (chunk: WireChunk): WireChunk =>
  chunk.choices === undefined
    ? chunk
    : {
        ...chunk,
        choices: chunk.choices.map((c) =>
          c.finish_reason === "model_length" ? { ...c, finish_reason: "length" } : c,
        ),
      }

export const decodeChunk = (u: unknown): Effect.Effect<WireChunk, unknown> =>
  decodeChunkShared(u).pipe(Effect.map(normalizeChunk))
