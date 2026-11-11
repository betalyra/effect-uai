import { Data, Duration, Effect, Exit, Match, Option, Schedule, Schema, Stream } from "effect"
import * as AiError from "../domain/AiError.js"

// ---------------------------------------------------------------------------
// Status + handle
// ---------------------------------------------------------------------------

/**
 * Normalized state of a provider-hosted background job. Implementors map their
 * provider's status vocabulary onto these four states. The terminal states
 * carry their payload: `Succeeded` the collected result, `Failed` the error
 * the implementor classified the provider's failure as (a refusal is
 * `ContentFiltered`, not a generic failure). This mirrors the wire, where a
 * single poll response returns both status and (when done) the outcome.
 *
 * A cancelled job settles as `Failed`.
 */
export type JobState<A, E = AiError.AiError> = Data.TaggedEnum<{
  Pending: {
    /** Places ahead in the provider's queue. Can rise as well as fall. */
    readonly queuePosition?: number
  }
  Running: {}
  Succeeded: { readonly result: A }
  Failed: { readonly error: E }
}>

interface JobStateDef extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: JobState<this["A"], this["B"]>
}

/** Constructors, guards and matchers. The type stays a structural union. */
export const JobState = Data.taggedEnum<JobStateDef>()

/** The two states that end a poll loop. */
export const isSettled = <A, E>(
  state: JobState<A, E>,
): state is Extract<JobState<A, E>, { _tag: "Succeeded" | "Failed" }> =>
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

/**
 * The ref, if `provider` owns it. Implementors check before a wire call, so
 * another provider's id never reaches their API as a confusing 404.
 */
export const own =
  (provider: string) =>
  <A>(ref: JobRef<A>): Effect.Effect<JobRef<A>, AiError.InvalidRequest> =>
    ref.provider === provider
      ? Effect.succeed(ref)
      : Effect.fail(
          new AiError.InvalidRequest({
            provider,
            param: "ref",
            raw: `A ${ref.provider} job ref, not ${provider}.`,
          }),
        )

// ---------------------------------------------------------------------------
// Poll driver
// ---------------------------------------------------------------------------

/**
 * The three wire operations a poll-based async job supplies. `run` / `collect`
 * drive the submit -> poll -> settle cadence around them, so an implementor
 * states only its provider calls, not the loop. `poll` returns the current
 * `JobState`, carrying the result in `Succeeded` and the job's own failure in
 * `Failed`; a failed poll (a dropped connection, a 503) is the effect's error.
 */
export type JobOps<Result, E = AiError.AiError> = {
  readonly submit: Effect.Effect<JobRef<Result>, AiError.AiError>
  readonly poll: Poll<Result, E>
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

export type Poll<Result, E = AiError.AiError> = (
  ref: JobRef<Result>,
) => Effect.Effect<JobState<Result, E>, AiError.AiError>

/**
 * Every polled state, on a jittered fixed cadence, ending with the first
 * settled one. The first poll runs immediately. Bounded as a whole by
 * `timeout`, which fails `Timeout`. Takes the poll op alone (not the full
 * `JobOps`) so a detached ref needs no submit-bound request.
 *
 * A failed poll ends the stream and leaves the job running; re-watching the
 * same ref is safe, so retry this (or {@link collect}), never {@link run}.
 */
export const watch = <Result, E>(
  poll: Poll<Result, E>,
  ref: JobRef<Result>,
  config?: JobConfig,
): Stream.Stream<JobState<Result, E>, AiError.AiError> =>
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

const unsettled = (ref: JobRef<unknown>, raw: unknown) =>
  new AiError.GenerationFailed({
    provider: ref.provider,
    message: "the job's states ended before it settled",
    raw,
  })

/**
 * Runs a stream of a job's states (a {@link watch}, tapped or filtered) and
 * returns what its last state carries: the result of `Succeeded`, the error
 * of `Failed`. Ending on a live state fails `GenerationFailed`.
 */
export const result =
  (ref: JobRef<unknown>) =>
  <Result, E, E2, R>(
    states: Stream.Stream<JobState<Result, E>, E2, R>,
  ): Effect.Effect<Result, E | E2 | AiError.GenerationFailed, R> =>
    Stream.runLast(states).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(unsettled(ref, ref)),
          onSome: (state): Effect.Effect<Result, E | AiError.GenerationFailed> =>
            Match.value(state).pipe(
              Match.tag("Succeeded", (s) => Effect.succeed(s.result)),
              Match.tag("Failed", (s) => Effect.fail(s.error)),
              Match.orElse((s) => Effect.fail(unsettled(ref, s))),
            ),
        }),
      ),
    )

/**
 * Poll until the job settles: its value on `Succeeded`, its error on
 * `Failed`, `Timeout` if it never settles. Interrupting it leaves the job
 * running.
 */
export const collect = <Result, E>(
  poll: Poll<Result, E>,
  ref: JobRef<Result>,
  config?: JobConfig,
): Effect.Effect<Result, AiError.AiError | E> => result(ref)(watch(poll, ref, config))

/**
 * Submit, then poll to completion. Cancels the server job (best effort) on
 * any exit but success: an interrupt, a timeout, a failed poll. The ref never
 * leaves this call, so a job it gave up on would otherwise run on, billed,
 * for nobody. Use `ops.submit` + `collect` directly for the detached case.
 */
export const run = <Result, E>(
  ops: JobOps<Result, E>,
  config?: JobConfig,
): Effect.Effect<Result, AiError.AiError | E> =>
  Effect.acquireUseRelease(
    ops.submit,
    (ref) => collect(ops.poll, ref, config),
    (ref, exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.ignore(ops.cancel(ref))),
  )
