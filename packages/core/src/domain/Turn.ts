import { Data, Effect, Result, Schema, Stream, pipe } from "effect"
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
 * State stamped with the just-completed `Turn`. Recipes use this as the
 * intermediate value between "turn lands" and "compute next state": extend
 * `state.history` with the turn's items, and keep the assembled turn
 * around for stop-reason / usage / function-call inspection.
 *
 * Generic over the recipe's state shape - any record carrying a
 * `history: ReadonlyArray<Item>` field works.
 */
export type Cursor<S> = S & { readonly turn: Turn }

/**
 * Build a `Cursor<S>` from a state record and the just-completed turn.
 * Extends `state.history` with `turn.items` and stamps the turn.
 */
export const cursor = <S extends { readonly history: ReadonlyArray<Item> }>(
  state: S,
  turn: Turn,
): Cursor<S> => ({
  ...state,
  history: [...state.history, ...turn.items],
  turn,
})

// ---------------------------------------------------------------------------
// Stream operators
// ---------------------------------------------------------------------------

/**
 * Project a `TurnEvent` stream onto its `text_delta` payloads. Other
 * variants are dropped. Composes with `accumulateLines` +
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

const lastAssistantContent = (
  turn: Turn,
): { readonly text: string; readonly refused: boolean } => {
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
