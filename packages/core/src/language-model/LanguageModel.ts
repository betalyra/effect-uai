import { Array as Arr, Context, Data, Effect, Option, type Schedule, Stream } from "effect"
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
 * Drain `streamTurn` and return the assembled `Turn` from the terminal
 * `turn_complete` event. Fails with `IncompleteTurn` if the stream ends
 * without one. Derived from `streamTurn`; providers get it for free.
 */
export const turn = (
  request: CommonRequest,
): Effect.Effect<Turn, AiError.AiError | AiError.IncompleteTurn, LanguageModel> =>
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

// ---------------------------------------------------------------------------
// retry — retry the retryable subset of AiError, let other failures escape
// ---------------------------------------------------------------------------

/** Internal wrapper around the retryable subset of `AiError`. */
export class Retryable extends Data.TaggedError("RetryableAi")<{
  readonly cause: AiError.RateLimited | AiError.Unavailable | AiError.Timeout
}> {}

const isRetryable = (
  e: AiError.AiError,
): e is AiError.RateLimited | AiError.Unavailable | AiError.Timeout =>
  e._tag === "RateLimited" || e._tag === "Unavailable" || e._tag === "Timeout"

// Lift events to Items, non-retryable failures to Terminal values (escape
// retry), retryable failures to wrapped errors (only thing retry sees).
type Lifted<A> =
  | { readonly _tag: "Item"; readonly value: A }
  | { readonly _tag: "Terminal"; readonly cause: AiError.AiError }

/**
 * Retry a stream of `AiError` on the retryable subset
 * (`RateLimited | Unavailable | Timeout`). Other failures bypass the
 * schedule and propagate unchanged. Like all `Stream.retry`, the entire
 * stream re-runs — deltas before the failure replay on the next attempt.
 */
export const retry =
  <Out>(schedule: Schedule.Schedule<Out, Retryable>) =>
  <A, R>(stream: Stream.Stream<A, AiError.AiError, R>): Stream.Stream<A, AiError.AiError, R> =>
    stream.pipe(
      Stream.map((value): Lifted<A> => ({ _tag: "Item", value })),
      Stream.catchIf(
        isRetryable,
        (cause) => Stream.fail(new Retryable({ cause })),
        (cause) => Stream.succeed<Lifted<A>>({ _tag: "Terminal", cause }),
      ),
      Stream.retry(schedule),
      Stream.catchTag("RetryableAi", (e) => Stream.fail<AiError.AiError>(e.cause)),
      Stream.flatMap((item) =>
        item._tag === "Item" ? Stream.succeed(item.value) : Stream.fail(item.cause),
      ),
    )
