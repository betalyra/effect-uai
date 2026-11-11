import { Data, Duration, Effect, Match, Option, Schedule, Schema, Stream } from "effect"
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
 *
 * A cancelled job settles as `Failed`.
 */
export type JobState<A> = Data.TaggedEnum<{
  Pending: {
    /** Places ahead in the provider's queue. Can rise as well as fall. */
    readonly queuePosition?: number
  }
  Running: {}
  Succeeded: { readonly result: A }
  Failed: { readonly reason?: string; readonly raw?: unknown }
}>

interface JobStateDef extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: JobState<this["A"]>
}

/** Constructors, guards and matchers. The type stays a structural union. */
export const JobState = Data.taggedEnum<JobStateDef>()

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
export interface JobRef<out A = unknown> {
  readonly _tag: "JobRef"
  readonly provider: string
  readonly id: string
  /** Phantom. Never present at runtime; ties the ref to its result type. */
  readonly [ResultType]?: A
}

/** Decodes a ref persisted to a queue or a database, as `JobRef<unknown>`. */
export const JobRef = Schema.TaggedStruct("JobRef", {
  provider: Schema.String,
  id: Schema.String,
})

/**
 * {@link JobRef} typed to the result it collects to. The phantom type is not
 * on the wire, so this is the capability's own claim: export one per
 * capability (`VideoGenerator.VideoJobRef`) rather than calling it ad hoc.
 */
export const refSchema = <A>(): Schema.Codec<JobRef<A>, typeof JobRef.Encoded> => JobRef

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

type Poll<Result> = (ref: JobRef<Result>) => Effect.Effect<JobState<Result>, AiError.AiError>

/**
 * Every polled state, on a jittered fixed cadence, ending with the first
 * settled one. The first poll runs immediately. Bounded as a whole by
 * `timeout`, which fails `Timeout`. Takes the poll op alone (not the full
 * `JobOps`) so a detached ref needs no submit-bound request.
 */
export const watch = <Result>(
  poll: Poll<Result>,
  ref: JobRef<Result>,
  config?: JobConfig,
): Stream.Stream<JobState<Result>, AiError.AiError> =>
  Stream.fromEffectSchedule(
    poll(ref),
    Schedule.jittered(Schedule.spaced(config?.pollInterval ?? DEFAULT_POLL_INTERVAL)),
  ).pipe(
    Stream.takeUntil(isSettled),
    Stream.interruptWhen(
      Effect.sleep(config?.timeout ?? DEFAULT_TIMEOUT).pipe(
        Effect.andThen(Effect.fail(new AiError.Timeout({ provider: ref.provider, raw: ref }))),
      ),
    ),
  )

const failed = (ref: JobRef<unknown>, reason?: string, raw?: unknown) =>
  Effect.fail(
    new AiError.GenerationFailed({
      provider: ref.provider,
      message: reason ?? "job failed",
      raw: raw ?? ref,
    }),
  )

/**
 * The result of a job's {@link watch}: its value on `Succeeded`,
 * `GenerationFailed` on `Failed`, `Timeout` if it never settles.
 */
export const collect = <Result>(
  poll: Poll<Result>,
  ref: JobRef<Result>,
  config?: JobConfig,
): Effect.Effect<Result, AiError.AiError> =>
  Stream.runLast(watch(poll, ref, config)).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => failed(ref),
        onSome: (state): Effect.Effect<Result, AiError.AiError> =>
          Match.value(state).pipe(
            Match.tag("Succeeded", (s) => Effect.succeed(s.result)),
            Match.tag("Failed", (s) => failed(ref, s.reason, s.raw)),
            Match.orElse(() => failed(ref)),
          ),
      }),
    ),
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
