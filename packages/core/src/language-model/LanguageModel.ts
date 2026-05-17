import { Array as Arr, Context, Effect, Option, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { Item } from "../domain/Items.js"
import type * as StructuredFormat from "../structured-format/StructuredFormat.js"
import type { ToolDescriptor } from "../tool/Tool.js"
import { isTurnComplete, type Turn, type TurnEvent } from "../domain/Turn.js"

/**
 * Cross-provider request shape. Every call carries its own `history` and
 * `model` - models are not bound at layer construction. Anything specific
 * to a single provider (reasoning effort, prompt caching, store flags,
 * ...) lives in that provider's own request interface, which extends this.
 */
export type CommonRequest = {
  readonly history: ReadonlyArray<Item>
  /**
   * Model identifier. Each provider narrows this to its typed literal union,
   * so code that yields a typed provider tag gets autocompletion.
   */
  readonly model: string
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

export type LanguageModelService = {
  readonly streamTurn: (request: CommonRequest) => Stream.Stream<TurnEvent, AiError.AiError>
  /**
   * Drain a single turn and return the assembled `Turn` from the
   * terminal `TurnComplete` event. Fails with `IncompleteTurn` if the
   * stream ends without one.
   *
   * Most providers derive this from `streamTurn` via
   * {@link turnFromStream}; providers with a native non-streaming
   * endpoint may override with a cheaper direct call.
   */
  readonly turn: (request: CommonRequest) => Effect.Effect<Turn, AiError.AiError>
}

export class LanguageModel extends Context.Service<LanguageModel, LanguageModelService>()(
  "@betalyra/effect-uai/LanguageModel",
) {}

/**
 * Stream the deltas of a single turn.
 */
export const streamTurn = (
  request: CommonRequest,
): Stream.Stream<TurnEvent, AiError.AiError, LanguageModel> =>
  Stream.unwrap(Effect.map(LanguageModel.asEffect(), (m) => m.streamTurn(request)))

/**
 * Drain a single turn and return the assembled `Turn`. Delegates to the
 * service's `turn` method — providers with a native complete endpoint
 * can override; the rest get the default streamTurn-drain via
 * {@link turnFromStream}.
 */
export const turn = (request: CommonRequest): Effect.Effect<Turn, AiError.AiError, LanguageModel> =>
  Effect.flatMap(LanguageModel.asEffect(), (m) => m.turn(request))

/**
 * Build a `turn` implementation from a `streamTurn` implementation.
 * Providers without a native non-streaming endpoint use this to
 * populate the service's `turn` field. Generic over the request type so
 * provider-typed services (with their narrowed request) can reuse it.
 */
export const turnFromStream =
  <Req>(streamTurn: (request: Req) => Stream.Stream<TurnEvent, AiError.AiError>) =>
  (request: Req): Effect.Effect<Turn, AiError.AiError> =>
    streamTurn(request).pipe(
      Stream.runCollect,
      Effect.flatMap((events) =>
        Arr.findLast(events, isTurnComplete).pipe(
          Option.match({
            onNone: () => Effect.fail(new AiError.IncompleteTurn({})),
            onSome: (e) => Effect.succeed(e.turn),
          }),
        ),
      ),
    )
