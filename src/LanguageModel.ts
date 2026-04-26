import { Context, Effect, Stream } from "effect"
import { AiError } from "./AiError.js"
import type { Item } from "./Items.js"
import type { ToolDescriptor } from "./Tool.js"
import { isTurnComplete, type Turn, type TurnDelta } from "./Turn.js"

/**
 * Cross-provider request options. Anything specific to a single provider
 * (reasoning effort, prompt caching, store flags, ...) lives in that
 * provider's own options interface, which extends this.
 */
export interface CommonRequestOptions {
  readonly tools?: ReadonlyArray<ToolDescriptor>
  readonly toolChoice?:
    | "auto"
    | "required"
    | "none"
    | { readonly type: "function"; readonly name: string }
  readonly temperature?: number
  readonly maxOutputTokens?: number
}

export interface LanguageModelService {
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: CommonRequestOptions,
  ) => Stream.Stream<TurnDelta, AiError>
}

export class LanguageModel extends Context.Service<LanguageModel, LanguageModelService>()(
  "@betalyra/effect-uai/LanguageModel",
) {}

/**
 * Stream the deltas of a single turn.
 */
export const streamTurn = (
  history: ReadonlyArray<Item>,
  options?: CommonRequestOptions,
): Stream.Stream<TurnDelta, AiError, LanguageModel> =>
  Stream.unwrap(Effect.map(LanguageModel.asEffect(), (m) => m.streamTurn(history, options)))

/**
 * Run a single turn to completion and return the assembled `Turn`.
 *
 * Implementation: drain the delta stream and pluck the terminal
 * `turn_complete` event. The provider is contractually required to emit
 * exactly one such event as the last delta.
 */
export const turn = (
  history: ReadonlyArray<Item>,
  options?: CommonRequestOptions,
): Effect.Effect<Turn, AiError, LanguageModel> =>
  Effect.flatMap(Stream.runCollect(streamTurn(history, options)), (deltas) => {
    const last = deltas[deltas.length - 1]
    return last !== undefined && isTurnComplete(last)
      ? Effect.succeed(last.turn)
      : Effect.fail(
          new AiError({
            message: "Provider stream ended without a turn_complete event",
          }),
        )
  })
