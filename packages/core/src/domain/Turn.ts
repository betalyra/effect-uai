import { Data, Effect, Result, Schema, Stream, pipe } from "effect"
import * as StructuredFormat from "../structured-format/StructuredFormat.js"
import {
  HistoryItem,
  Message,
  Reasoning,
  StopReason,
  ToolCall,
  ToolCallOutput,
  Usage,
  isOutputText,
  isReasoning,
  isRefusal,
  isToolCall,
} from "./Items.js"

/**
 * The result of a single LLM generation. A turn produces zero or more items
 * (typically one assistant message and zero or more function_call items)
 * and reports usage + a stop reason.
 */
export const Turn = Schema.Struct({
  items: Schema.Array(HistoryItem),
  usage: Usage,
  stop_reason: StopReason,
})
export type Turn = typeof Turn.Type

/**
 * Canonical events emitted while a single turn is being generated. Most
 * variants are streaming deltas (text, reasoning, tool-call args); the
 * terminal `TurnComplete` carries the assembled `Turn`. Lifecycle members
 * aren't deltas, hence the union name.
 *
 * `ReasoningDelta.kind`: `trace` is the model's raw chain-of-thought;
 * `summary` is a model-written summary intended for display. OpenAI
 * Responses emits both; Anthropic and Gemini only emit `trace`.
 *
 * `RefusalDelta`: the model declined to answer. OpenAI Responses emits
 * this as its own event; Anthropic surfaces refusals via `stop_reason`
 * and Gemini collapses them into `finishReason: SAFETY` — both go
 * without a `RefusalDelta`.
 *
 * `UsageUpdate`: mid-stream cumulative usage. Anthropic emits this on
 * `message_start` and `message_delta`; other providers may only deliver
 * usage via `TurnComplete.turn.usage`.
 */
export type TurnEvent = Data.TaggedEnum<{
  TextDelta: { readonly text: string }
  ReasoningDelta: { readonly text: string; readonly kind: "trace" | "summary" }
  RefusalDelta: { readonly text: string }
  ToolCallStart: { readonly call_id: string; readonly name: string }
  ToolCallArgsDelta: { readonly call_id: string; readonly delta: string }
  UsageUpdate: { readonly usage: Usage }
  TurnComplete: { readonly turn: Turn }
}>

export const TurnEvent = Data.taggedEnum<TurnEvent>()

/**
 * What flows out of an agent loop body to its consumer per turn: every
 * `TurnEvent` the provider emits (including the terminal `TurnComplete`
 * carrying the assembled `Turn`), plus the output of any tool the loop ran.
 * Both variants carry a `_tag` discriminator.
 */
export type InteractionEvent = TurnEvent | ToolCallOutput

export const isTurnComplete = TurnEvent.$is("TurnComplete")

export const getToolCalls = (turn: Turn): ReadonlyArray<ToolCall> => turn.items.filter(isToolCall)

export const reasonings = (turn: Turn): ReadonlyArray<Reasoning> => turn.items.filter(isReasoning)

export const assistantMessages = (turn: Turn): ReadonlyArray<Message> =>
  turn.items.filter((i): i is Message => i.type === "message" && i.role === "assistant")

/**
 * Every `output_text` payload across every assistant message in the turn,
 * preserving order. Refusals and other content blocks are dropped — use
 * `assistantMessages` if you need to inspect them. The primitive for
 * "give me the assistant's text"; callers decide how to combine
 * (typically `.join("")` for prose or `.join(" ")` for log strings).
 */
export const assistantTexts = (turn: Turn): ReadonlyArray<string> =>
  assistantMessages(turn)
    .flatMap((m) => m.content)
    .filter(isOutputText)
    .map((b) => b.text)

/**
 * Sugar over `assistantTexts(turn).join("")` — the common case for
 * summarizers, classifiers, judge calls, and structured-output backstops
 * that want one concatenated string.
 */
export const assistantText = (turn: Turn): string => assistantTexts(turn).join("")

/**
 * Append a completed turn and optional follow-up items to a state record's
 * history. Recipes use this at the point where structured tool results are
 * converted to model-facing `ToolCallOutput`s.
 */
export const appendToHistory = <S extends { readonly history: ReadonlyArray<HistoryItem> }>(
  state: S,
  turn: Turn,
  items: ReadonlyArray<HistoryItem> = [],
): S => ({
  ...state,
  history: [...state.history, ...turn.items, ...items],
})

// ---------------------------------------------------------------------------
// Stream operators
// ---------------------------------------------------------------------------

/**
 * Project a `TurnEvent` stream onto its `TextDelta` payloads. Other
 * variants are dropped. Composes with `Lines.lines` +
 * `decodeJsonLines` for prompted-JSONL streaming.
 */
export const textDeltas = <E, R>(
  self: Stream.Stream<TurnEvent, E, R>,
): Stream.Stream<string, E, R> =>
  self.pipe(
    Stream.filterMap((ev) => (ev._tag === "TextDelta" ? Result.succeed(ev.text) : Result.failVoid)),
  )

// ---------------------------------------------------------------------------
// Structured-output integration
// ---------------------------------------------------------------------------

/**
 * The assistant message on the just-completed turn was a refusal block,
 * not an `output_text` payload. Returned by `decodeStructured` to short-circuit
 * decoding before `JSON.parse` / schema validation runs.
 */
export class RefusalRejected extends Data.TaggedError("RefusalRejected")<{
  readonly turn: Turn
}> {}

const lastAssistantContent = (turn: Turn): { readonly text: string; readonly refused: boolean } => {
  const assistants = assistantMessages(turn)
  const last = assistants[assistants.length - 1]
  if (last === undefined) return { text: "", refused: false }
  if (last.content.some(isRefusal)) return { text: "", refused: true }
  const text = last.content
    .filter(isOutputText)
    .map((b) => b.text)
    .join("")
  return { text, refused: false }
}

/**
 * Validate a completed `Turn` against a `StructuredFormat`. Concatenates
 * `output_text` blocks on the last assistant message, then runs
 * `JSON.parse` + the format's schema validation.
 *
 * Three failure modes:
 * - `RefusalRejected` — the assistant emitted a refusal block.
 * - `JsonParseError` — the assembled text wasn't valid JSON.
 * - `StructuredDecodeError` — the JSON didn't match the schema.
 */
export const decodeStructured = <A>(
  turn: Turn,
  format: StructuredFormat.StructuredFormat<A>,
): Effect.Effect<
  A,
  RefusalRejected | StructuredFormat.JsonParseError | StructuredFormat.StructuredDecodeError
> =>
  pipe(lastAssistantContent(turn), ({ text, refused }) =>
    refused ? Effect.fail(new RefusalRejected({ turn })) : StructuredFormat.parseJson(format)(text),
  )
