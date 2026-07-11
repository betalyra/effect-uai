import { Duration, Effect, Schedule } from "effect"
import * as AiError from "../domain/AiError.js"

// ---------------------------------------------------------------------------
// Status + handle
// ---------------------------------------------------------------------------

/**
 * Normalized status of a provider-hosted background job. Implementors map
 * their provider's status vocabulary onto these four buckets.
 */
export type JobStatus = "queued" | "in_progress" | "completed" | "failed"

/** The two statuses that end a poll loop. */
export const isTerminal = (status: JobStatus): status is "completed" | "failed" =>
  status === "completed" || status === "failed"

/**
 * Opaque, provider-tagged handle to a running background job. Jobs can run for
 * minutes and outlive a single process, so the handle is detachable: submit
 * now, collect later. `provider` tags who owns `id`.
 */
export type JobRef = {
  readonly _tag: "JobRef"
  readonly provider: string
  readonly id: string
}

export const jobRef = (provider: string, id: string): JobRef => ({
  _tag: "JobRef",
  provider,
  id,
})

// ---------------------------------------------------------------------------
// Poll driver
// ---------------------------------------------------------------------------

/**
 * The four wire operations a poll-based async job supplies. `run` / `collect`
 * drive the submit -> poll -> collect cadence around them, so an implementor
 * states only its provider calls, not the loop. Generic over the collected
 * `Result`.
 */
export type JobOps<Result> = {
  readonly submit: Effect.Effect<JobRef, AiError.AiError>
  readonly status: (ref: JobRef) => Effect.Effect<JobStatus, AiError.AiError>
  readonly report: (ref: JobRef) => Effect.Effect<Result, AiError.AiError>
  readonly cancel: (ref: JobRef) => Effect.Effect<void, AiError.AiError>
}

export type JobConfig = {
  /** Cadence between status fetches. Default 10 seconds, jittered. */
  readonly pollInterval?: Duration.DurationInput
  /** Overall wait cap; exceeding it fails `Timeout`. Default 45 minutes. */
  readonly timeout?: Duration.DurationInput
}

const DEFAULT_POLL_INTERVAL: Duration.DurationInput = "10 seconds"
const DEFAULT_TIMEOUT: Duration.DurationInput = "45 minutes"

/**
 * Poll `ops.status(ref)` on a jittered fixed cadence until terminal, then
 * fetch the result, or fail `GenerationFailed` on `failed`. Bounded by
 * `timeout`, which fails `Timeout` if the job never settles.
 */
export const collect = <Result>(
  ops: JobOps<Result>,
  ref: JobRef,
  config?: JobConfig,
): Effect.Effect<Result, AiError.AiError> =>
  ops.status(ref).pipe(
    Effect.repeat({
      schedule: Schedule.jittered(Schedule.spaced(config?.pollInterval ?? DEFAULT_POLL_INTERVAL)),
      until: isTerminal,
    }),
    Effect.flatMap((status) =>
      status === "failed"
        ? Effect.fail(
            new AiError.GenerationFailed({
              provider: ref.provider,
              message: "job failed",
              raw: ref,
            }),
          )
        : ops.report(ref),
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
      collect(ops, ref, config).pipe(Effect.onInterrupt(() => Effect.ignore(ops.cancel(ref)))),
    ),
  )
