import { Context, Effect, Stream } from "effect"
import { AiError } from "./AiError.js"
import type { Item } from "./Items.js"
import { isTurnComplete, type Turn, type TurnDelta } from "./Turn.js"

export interface LanguageModelService {
  readonly streamTurn: (
    history: ReadonlyArray<Item>
  ) => Stream.Stream<TurnDelta, AiError>
}

export class LanguageModel extends Context.Service<
  LanguageModel,
  LanguageModelService
>()("@betalyra/effect-uai/LanguageModel") {}

/**
 * Stream the deltas of a single turn.
 */
export const streamTurn = (
  history: ReadonlyArray<Item>
): Stream.Stream<TurnDelta, AiError, LanguageModel> =>
  Stream.unwrap(
    Effect.map(LanguageModel.asEffect(), (m) => m.streamTurn(history))
  )

/**
 * Run a single turn to completion and return the assembled `Turn`.
 *
 * Implementation: drain the delta stream and pluck the terminal
 * `turn_complete` event. The provider is contractually required to emit
 * exactly one such event as the last delta.
 */
export const turn = (
  history: ReadonlyArray<Item>
): Effect.Effect<Turn, AiError, LanguageModel> =>
  Effect.flatMap(Stream.runCollect(streamTurn(history)), (deltas) => {
    const last = deltas[deltas.length - 1]
    return last !== undefined && isTurnComplete(last)
      ? Effect.succeed(last.turn)
      : Effect.fail(
          new AiError({
            message: "Provider stream ended without a turn_complete event"
          })
        )
  })
