import { Effect, Option, Schema, Stream } from "effect"
import { FunctionCall, Item, Message, Reasoning, StopReason, Usage } from "./Items.js"

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
 * Streaming deltas emitted while a single turn is being generated.
 * The terminal event is always `turn_complete`, carrying the assembled Turn.
 */
export type TurnDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "reasoning_summary_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly call_id: string; readonly name: string }
  | { readonly type: "tool_call_args_delta"; readonly call_id: string; readonly delta: string }
  | { readonly type: "turn_complete"; readonly turn: Turn }

export const isTurnComplete = (d: TurnDelta): d is Extract<TurnDelta, { type: "turn_complete" }> =>
  d.type === "turn_complete"

export const functionCalls = (turn: Turn): ReadonlyArray<FunctionCall> =>
  turn.items.filter((i): i is FunctionCall => i.type === "function_call")

export const reasonings = (turn: Turn): ReadonlyArray<Reasoning> =>
  turn.items.filter((i): i is Reasoning => i.type === "reasoning")

export const assistantMessages = (turn: Turn): ReadonlyArray<Message> =>
  turn.items.filter((i): i is Message => i.type === "message" && i.role === "assistant")

/**
 * Drain a `TurnDelta` stream and return the assembled `Turn` carried by its
 * terminal `turn_complete` event, or `Option.none()` if the stream ended
 * without one. The caller decides what "no terminal event" means — usually
 * `AiError`, but a partial-content recovery path is also valid.
 */
export const untilTurnComplete = <E, R>(
  stream: Stream.Stream<TurnDelta, E, R>,
): Effect.Effect<Option.Option<Turn>, E, R> =>
  Stream.runFold(stream, Option.none<Turn>, (acc, delta) =>
    delta.type === "turn_complete" ? Option.some(delta.turn) : acc,
  )
