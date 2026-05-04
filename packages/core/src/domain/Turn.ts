import { Data, Effect, Result, Schema, Stream, pipe } from "effect"
import type * as SSE from "../streaming/SSE.js"
import * as StructuredFormat from "../structured-format/StructuredFormat.js"
import {
  FunctionCall,
  FunctionCallOutput,
  Item,
  isOutputText,
  isRefusal,
  Message,
  Reasoning,
  StopReason,
  Usage,
} from "./Items.js"

/**
 * The result of a single LLM generation. A turn produces zero or more items
 * (typically one assistant message and zero or more function_call items)
 * and reports usage + a stop reason.
 */
export const Turn = Schema.Struct({
  items: Schema.Array(Item),
  usage: Usage,
  stop_reason: StopReason,
})
export type Turn = typeof Turn.Type

/**
 * Canonical events emitted while a single turn is being generated. Most
 * variants are streaming deltas (text, reasoning, tool-call args); the
 * terminal `turn_complete` carries the assembled `Turn`. Lifecycle members
 * aren't deltas, hence the union name.
 */
export type TurnEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "reasoning_delta"
      readonly text: string
      /**
       * `trace` is the model's raw chain-of-thought; `summary` is a
       * model-written summary intended for display. OpenAI Responses emits
       * both as separate wire events; Anthropic and Gemini only emit
       * `trace`. Consumers who just want any reasoning text match once;
       * those who want only summaries filter `kind === "summary"`.
       */
      readonly kind: "trace" | "summary"
    }
  /**
   * The model declined to answer. `text` is the (streamed) explanation.
   * Distinct from the failure channel: a refusal is normal model output and
   * the stream still completes with `turn_complete`. OpenAI Responses emits
   * this; Anthropic surfaces refusals via `stop_reason`, and Gemini collapses
   * them into `finishReason: SAFETY` - both go without a `refusal_delta`.
   */
  | { readonly type: "refusal_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly call_id: string; readonly name: string }
  | { readonly type: "tool_call_args_delta"; readonly call_id: string; readonly delta: string }
  /**
   * Mid-stream cumulative usage. Carries the full `Usage` (including cache
   * token fields when the provider surfaces them) so consumers can drive
   * live budget / cost tracking without waiting for `turn_complete`.
   * Anthropic emits this on `message_start` and `message_delta`; other
   * providers may not emit any `usage_update` and only deliver usage via
   * `turn_complete.turn.usage`.
   */
  | { readonly type: "usage_update"; readonly usage: Usage }
  | { readonly type: "turn_complete"; readonly turn: Turn }

/**
 * What flows out of an agent loop body to its consumer per turn: every
 * `TurnEvent` the provider emits (including the terminal `turn_complete`
 * carrying the assembled `Turn`), plus the output of any tool the loop ran.
 * Both variants carry a `type` discriminator.
 */
export type InteractionEvent = TurnEvent | FunctionCallOutput

export const isTurnComplete = (d: TurnEvent): d is Extract<TurnEvent, { type: "turn_complete" }> =>
  d.type === "turn_complete"

export const functionCalls = (turn: Turn): ReadonlyArray<FunctionCall> =>
  turn.items.filter((i): i is FunctionCall => i.type === "function_call")

export const reasonings = (turn: Turn): ReadonlyArray<Reasoning> =>
  turn.items.filter((i): i is Reasoning => i.type === "reasoning")

export const assistantMessages = (turn: Turn): ReadonlyArray<Message> =>
  turn.items.filter((i): i is Message => i.type === "message" && i.role === "assistant")

/**
 * Append a completed turn and optional follow-up items to a state record's
 * history. Recipes use this at the point where structured tool results are
 * converted to model-facing `FunctionCallOutput`s.
 */
export const appendTurn = <S extends { readonly history: ReadonlyArray<Item> }>(
  state: S,
  turn: Turn,
  items: ReadonlyArray<Item> = [],
): S => ({
  ...state,
  history: [...state.history, ...turn.items, ...items],
})

// ---------------------------------------------------------------------------
// Stream operators
// ---------------------------------------------------------------------------

/**
 * Project a `TurnEvent` stream onto its `text_delta` payloads. Other
 * variants are dropped. Composes with `Lines.lines` +
 * `decodeJsonLines` for prompted-JSONL streaming.
 */
export const textDeltas = <E, R>(
  self: Stream.Stream<TurnEvent, E, R>,
): Stream.Stream<string, E, R> =>
  self.pipe(
    Stream.filterMap((ev) =>
      ev.type === "text_delta" ? Result.succeed(ev.text) : Result.failVoid,
    ),
  )

// ---------------------------------------------------------------------------
// Wire formatters - project a `TurnEvent` onto a transport-friendly frame.
//
// Use as `Stream.filterMap(toSSE)` (browser EventSource) or
// `Stream.filterMap(toJSONL)` (CLI pipes, queue payloads, log shipping).
// Reasoning deltas, tool-call argument deltas, and other observability
// events are dropped; recipes that need them write their own projection.
// ---------------------------------------------------------------------------

const finalText = (turn: Turn): string =>
  assistantMessages(turn)
    .flatMap((m) => m.content)
    .filter(isOutputText)
    .map((c) => c.text)
    .join("")

/** Project one `TurnEvent` into one named SSE event, or drop it. */
export const toSSE = (event: TurnEvent): Result.Result<SSE.Event, void> => {
  if (event.type === "text_delta") {
    return Result.succeed({ event: "text", data: JSON.stringify({ text: event.text }) })
  }
  if (event.type === "turn_complete") {
    return Result.succeed({
      event: "done",
      data: JSON.stringify({
        stop_reason: event.turn.stop_reason,
        text: finalText(event.turn),
        usage: event.turn.usage,
      }),
    })
  }
  return Result.failVoid
}

/** Project one `TurnEvent` into one JSONL line (newline-terminated), or drop it. */
export const toJSONL = (event: TurnEvent): Result.Result<string, void> => {
  if (event.type === "text_delta") {
    return Result.succeed(JSON.stringify({ type: "text", text: event.text }) + "\n")
  }
  if (event.type === "turn_complete") {
    return Result.succeed(
      JSON.stringify({
        type: "done",
        stop_reason: event.turn.stop_reason,
        text: finalText(event.turn),
        usage: event.turn.usage,
      }) + "\n",
    )
  }
  return Result.failVoid
}

/**
 * Curried `Stream.filterMap(toSSE)`. Drop into a `pipe` directly:
 * `stream.pipe(asSSE)`.
 */
export const asSSE: <E, R>(
  self: Stream.Stream<TurnEvent, E, R>,
) => Stream.Stream<SSE.Event, E, R> = Stream.filterMap(toSSE)

/**
 * Curried `Stream.filterMap(toJSONL)`. Drop into a `pipe` directly:
 * `stream.pipe(asJSONL)`.
 */
export const asJSONL: <E, R>(
  self: Stream.Stream<TurnEvent, E, R>,
) => Stream.Stream<string, E, R> = Stream.filterMap(toJSONL)

// ---------------------------------------------------------------------------
// Structured-output integration
// ---------------------------------------------------------------------------

/**
 * The assistant message on the just-completed turn was a refusal block,
 * not an `output_text` payload. Returned by `toStructured` to short-circuit
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
export const toStructured = <A>(
  turn: Turn,
  format: StructuredFormat.StructuredFormat<A>,
): Effect.Effect<
  A,
  RefusalRejected | StructuredFormat.JsonParseError | StructuredFormat.StructuredDecodeError
> =>
  pipe(lastAssistantContent(turn), ({ text, refused }) =>
    refused ? Effect.fail(new RefusalRejected({ turn })) : StructuredFormat.parseJson(format)(text),
  )
