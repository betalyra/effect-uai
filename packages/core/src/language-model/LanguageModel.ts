import { Context, Effect, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { Item } from "../domain/Items.js"
import type * as StructuredFormat from "../structured-format/StructuredFormat.js"
import type { ToolDescriptor } from "../tool/Tool.js"
import { isTurnComplete, type Turn, type TurnEvent } from "../domain/Turn.js"

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
  readonly topP?: number
  readonly maxOutputTokens?: number
  /**
   * Schema-bound JSON output. The provider constrains the wire to match the
   * schema; pair with `Turn.toStructured` for runtime validation. Supported
   * across all current providers (OpenAI Responses json_schema, Anthropic
   * `output_config`, Gemini `responseJsonSchema`).
   */
  readonly structured?: StructuredFormat.StructuredFormat<unknown>
}

export interface LanguageModelService {
  readonly streamTurn: (
    history: ReadonlyArray<Item>,
    options?: CommonRequestOptions,
  ) => Stream.Stream<TurnEvent, AiError.AiError>
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
): Stream.Stream<TurnEvent, AiError.AiError, LanguageModel> =>
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
): Effect.Effect<Turn, AiError.AiError, LanguageModel> =>
  Effect.flatMap(Stream.runCollect(streamTurn(history, options)), (deltas) => {
    const last = deltas[deltas.length - 1]
    return last !== undefined && isTurnComplete(last)
      ? Effect.succeed(last.turn)
      : Effect.fail(
          new AiError.Unavailable({
            provider: "unknown",
            raw: "Provider stream ended without a turn_complete event",
          }),
        )
  })
