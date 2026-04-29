import { Effect, Option, Ref, Schema, Stream } from "effect"
import { IncompleteTurn } from "./AiError.js"
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

type NonTerminalTurnDelta = Exclude<TurnDelta, { readonly type: "turn_complete" }>

interface StreamUntilCompleteOptions<A, E2, R2> {
  readonly emit: (delta: NonTerminalTurnDelta) => Stream.Stream<A, E2, R2>
  readonly then: (turn: Turn) => Effect.Effect<Stream.Stream<A, E2, R2>, E2, R2>
}

/**
 * Stream non-terminal turn deltas as user-facing events, then continue with
 * the completed `Turn`. Callers still own the loop, tools, and state.
 * Useful inside a `Loop` body to forward deltas in real time and decide
 * what to do once the turn lands.
 *
 * If the upstream ends without a `turn_complete`, the resulting stream
 * fails with `AiError.IncompleteTurn`. Catch it via `Stream.catchTag` if
 * you want to recover.
 */
export const streamUntilComplete =
  <A, E2 = never, R2 = never>(options: StreamUntilCompleteOptions<A, E2, R2>) =>
  <E, R>(
    deltas: Stream.Stream<TurnDelta, E, R>,
  ): Stream.Stream<A, E | E2 | IncompleteTurn, R | R2> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const turnRef = yield* Ref.make<Option.Option<Turn>>(Option.none())

        const events = deltas.pipe(
          Stream.takeUntil(isTurnComplete),
          Stream.tap((delta) =>
            isTurnComplete(delta) ? Ref.set(turnRef, Option.some(delta.turn)) : Effect.void,
          ),
          Stream.flatMap((delta) =>
            isTurnComplete(delta) ? Stream.empty : options.emit(delta),
          ),
        )

        const continuation = Stream.unwrap(
          Effect.gen(function* () {
            const opt = yield* Ref.get(turnRef)
            if (Option.isNone(opt)) return yield* Effect.fail(new IncompleteTurn({}))
            return yield* options.then(opt.value)
          }),
        )

        return Stream.concat(events, continuation)
      }),
    )
