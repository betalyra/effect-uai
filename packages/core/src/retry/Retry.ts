import { Data, Effect, type Schedule, Stream } from "effect"
import type * as AiError from "../domain/AiError.js"

/**
 * Subset-aware retry helpers for `AiError`.
 *
 * Effect's own `Effect.retry` / `Stream.retry` apply the schedule to
 * every failure. For AI calls that's the wrong policy — replaying a
 * `ContentFiltered` or `InvalidRequest` won't change the outcome and
 * just wastes quota. These helpers gate the schedule on the
 * {@link Retryable} subset (rate limits, transport hiccups, timeouts);
 * everything else propagates unchanged.
 *
 * Two carriers:
 * - {@link stream} — for `Stream<A, AiError, R>` (e.g. `streamTurn`,
 *   `streamSynthesis`, `streamTranscriptionFrom`). Caveat: the entire
 *   stream re-runs on retry, so deltas before the failure replay on
 *   the next attempt.
 * - {@link effect} — for `Effect<A, AiError, R>` (e.g. `turn`, `embed`,
 *   `embedMany`, `synthesize`, `transcribe`). At-most-once.
 *
 * Composes with `Stream.retry` / `Effect.retry` directly (no naming
 * collision since these live under the `Retry` namespace).
 */

/**
 * Wrapper around the retryable subset of `AiError`. Internal to the
 * lift/retry/unlift dance — exported so callers can build their own
 * variants if needed (e.g. a custom schedule that observes `cause`).
 */
export class Retryable extends Data.TaggedError("RetryableAi")<{
  readonly cause: AiError.RateLimited | AiError.Unavailable | AiError.Timeout
}> {}

/** Type-narrowing predicate for the retryable subset. */
export const isRetryable = (
  e: AiError.AiError,
): e is AiError.RateLimited | AiError.Unavailable | AiError.Timeout =>
  e._tag === "RateLimited" || e._tag === "Unavailable" || e._tag === "Timeout"

// Lift events to Items, non-retryable failures to Terminal values
// (escape retry), retryable failures to wrapped errors (only thing
// retry sees).
type Lifted<A> =
  | { readonly _tag: "Item"; readonly value: A }
  | { readonly _tag: "Terminal"; readonly cause: AiError.AiError }

/**
 * Retry a `Stream<A, AiError, R>` on the retryable subset. Other
 * failures bypass the schedule and propagate unchanged. The whole
 * stream replays on each attempt — deltas emitted before the failure
 * are re-emitted on the next try.
 */
export const stream =
  <Out>(schedule: Schedule.Schedule<Out, Retryable>) =>
  <A, R>(s: Stream.Stream<A, AiError.AiError, R>): Stream.Stream<A, AiError.AiError, R> =>
    s.pipe(
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

/**
 * Retry an `Effect<A, AiError, R>` on the retryable subset. Other
 * failures bypass the schedule and propagate unchanged. At-most-once
 * — the underlying call only re-runs if the previous attempt failed
 * with a retryable tag.
 *
 * Skips the lift/unlift dance the Stream variant needs: `Effect.retry`
 * exposes a `while:` predicate so the error channel stays a plain
 * `AiError` throughout.
 */
export const effect =
  <Out>(schedule: Schedule.Schedule<Out, AiError.AiError>) =>
  <A, R>(eff: Effect.Effect<A, AiError.AiError, R>): Effect.Effect<A, AiError.AiError, R> =>
    Effect.retry(eff, { schedule, while: isRetryable })
