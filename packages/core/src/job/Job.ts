import { Duration, Effect, Schedule } from "effect"
import * as AiError from "../domain/AiError.js"

// ---------------------------------------------------------------------------
// Status + handle
// ---------------------------------------------------------------------------

/**
 * Normalized state of a provider-hosted background job. Implementors map their
 * provider's status vocabulary onto these four states. The terminal states
 * carry their payload: `Succeeded` the collected result, `Failed` an optional
 * reason and the raw provider error. This mirrors the wire, where a single
 * poll response returns both status and (when done) the result.
 */
export type JobState<A> =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Succeeded"; readonly result: A }
  | { readonly _tag: "Failed"; readonly reason?: string; readonly raw?: unknown }

/** The two states that end a poll loop. */
export const isSettled = <A>(
  state: JobState<A>,
): state is Extract<JobState<A>, { _tag: "Succeeded" | "Failed" }> =>
  state._tag === "Succeeded" || state._tag === "Failed"

declare const ResultType: unique symbol

/**
 * Opaque, provider-tagged handle to a running background job. Jobs can run for
 * minutes and outlive a single process, so the handle is detachable: submit
 * now, collect later. `provider` tags who owns `id`.
 *
 * Parameterized by the result type `A` it collects to, so a ref cannot be
 * crossed between capabilities (a `JobRef<Turn>` is not a `JobRef<VideoResult>`).
 * The brand is phantom: the runtime value is just `{ _tag, provider, id }`, so
 * a ref stays plain serializable data for persistence across restarts.
 */
export type JobRef<A = unknown> = {
  readonly _tag: "JobRef"
  readonly provider: string
  readonly id: string
  readonly [ResultType]?: A
}

export const jobRef = <A = unknown>(provider: string, id: string): JobRef<A> => ({
  _tag: "JobRef",
  provider,
  id,
})

// ---------------------------------------------------------------------------
// Poll driver
// ---------------------------------------------------------------------------

/**
 * The three wire operations a poll-based async job supplies. `run` / `collect`
 * drive the submit -> poll -> settle cadence around them, so an implementor
 * states only its provider calls, not the loop. `poll` returns the current
 * `JobState`, carrying the result in `Succeeded`. Generic over the collected
 * `Result`.
 */
export type JobOps<Result> = {
  readonly submit: Effect.Effect<JobRef<Result>, AiError.AiError>
  readonly poll: (ref: JobRef<Result>) => Effect.Effect<JobState<Result>, AiError.AiError>
  readonly cancel: (ref: JobRef<Result>) => Effect.Effect<void, AiError.AiError>
}

export type JobConfig = {
  /** Cadence between status fetches. Default 10 seconds, jittered. */
  readonly pollInterval?: Duration.Input
  /** Overall wait cap; exceeding it fails `Timeout`. Default 45 minutes. */
  readonly timeout?: Duration.Input
}

const DEFAULT_POLL_INTERVAL: Duration.Input = "10 seconds"
const DEFAULT_TIMEOUT: Duration.Input = "45 minutes"

/**
 * Poll `poll(ref)` on a jittered fixed cadence until the job settles, then
 * return the result or fail `GenerationFailed`. Bounded by `timeout`, which
 * fails `Timeout` if the job never settles. Takes the poll op alone (not the
 * full `JobOps`) so a detached `collect(ref)` needs no submit-bound request.
 */
export const collect = <Result>(
  poll: (ref: JobRef<Result>) => Effect.Effect<JobState<Result>, AiError.AiError>,
  ref: JobRef<Result>,
  config?: JobConfig,
): Effect.Effect<Result, AiError.AiError> =>
  poll(ref).pipe(
    Effect.repeat({
      schedule: Schedule.jittered(Schedule.spaced(config?.pollInterval ?? DEFAULT_POLL_INTERVAL)),
      until: isSettled,
    }),
    Effect.flatMap((state) =>
      state._tag === "Succeeded"
        ? Effect.succeed(state.result)
        : Effect.fail(
            new AiError.GenerationFailed({
              provider: ref.provider,
              message: state._tag === "Failed" ? (state.reason ?? "job failed") : "job failed",
              raw: state._tag === "Failed" ? (state.raw ?? ref) : ref,
            }),
          ),
    ),
    Effect.timeoutOrElse({
      duration: config?.timeout ?? DEFAULT_TIMEOUT,
      orElse: () => Effect.fail(new AiError.Timeout({ provider: ref.provider, raw: ref })),
    }),
  )

/**
 * Submit, then poll to completion. Best-effort cancels the server job if the
 * caller interrupts (where the provider supports it). The one-call path; use
 * `ops.submit` + `collect` directly for the detached case.
 */
export const run = <Result>(
  ops: JobOps<Result>,
  config?: JobConfig,
): Effect.Effect<Result, AiError.AiError> =>
  ops.submit.pipe(
    Effect.flatMap((ref) =>
      collect(ops.poll, ref, config).pipe(Effect.onInterrupt(() => Effect.ignore(ops.cancel(ref)))),
    ),
  )
