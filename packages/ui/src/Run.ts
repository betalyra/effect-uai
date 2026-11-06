/**
 * Server-side stream helpers for runs, piped like the metrics helpers:
 *
 *   agent(history).pipe(
 *     Projection.toRunEvents(),
 *     Run.coalesce("50 millis"),
 *     Run.withTerminal({ runId, inputs }),
 *     Run.sequence(streamId),
 *   )
 *
 * Direct-mode stop needs no helper: `Stream.toReadableStream(body, { signal:
 * request.signal })` and Effect's `HttpServer` interrupt the stream when the
 * client goes away.
 */
import { Array as Arr, Cause, Effect, Predicate, Ref, Schema, Stream } from "effect"
import type * as Duration from "effect/Duration"
import {
  type Envelope,
  type InputId,
  isTerminal,
  PROTOCOL_VERSION,
  RunId,
  type RunEvent,
  type StreamId,
} from "./RunEvent.js"

// ---------------------------------------------------------------------------
// sequence
// ---------------------------------------------------------------------------

export const SequenceState = Schema.Struct({
  seq: Schema.Int,
  /** Id of the run currently open on this stream. */
  runId: Schema.optionalKey(RunId),
})
export type SequenceState = typeof SequenceState.Type

const sequenceStep =
  (streamId: StreamId) =>
  (s: SequenceState, event: RunEvent): readonly [SequenceState, ReadonlyArray<Envelope>] => {
    const runId = event.type === "run-started" ? event.runId : s.runId
    const seq = s.seq + 1
    const envelope: Envelope =
      runId === undefined ? { streamId, seq, event } : { streamId, seq, runId, event }
    const next: SequenceState = runId === undefined || isTerminal(event) ? { seq } : { seq, runId }
    return [next, [envelope]]
  }

/**
 * Wrap events in envelopes with a per-stream `seq` (starting after `from`,
 * default 0) and the current run's id, taken from the last `run-started`.
 */
export const sequence =
  (streamId: StreamId, options?: { readonly from?: number }) =>
  <E, R>(self: Stream.Stream<RunEvent, E, R>): Stream.Stream<Envelope, E, R> =>
    self.pipe(
      Stream.mapAccum((): SequenceState => ({ seq: options?.from ?? 0 }), sequenceStep(streamId)),
    )

// ---------------------------------------------------------------------------
// withTerminal
// ---------------------------------------------------------------------------

export type RunOptions = {
  readonly runId: RunId
  readonly messageId?: string
  /** Client input ids the run consumes. */
  readonly inputs?: ReadonlyArray<InputId>
  /** Role label when a stream carries several runs. */
  readonly name?: string
  /** When this completes, the run ends with `run-stopped` (e.g. a durable run's stop `Deferred`). */
  readonly stopWhen?: Effect.Effect<void>
}

// Transient provider failures (`AiError` tags) a client may retry.
const RETRYABLE: ReadonlySet<string> = new Set(["RateLimited", "Unavailable", "Timeout"])

const failed = (cause: Cause.Cause<unknown>): RunEvent => {
  const error = Cause.squash(cause)
  const tag =
    Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : undefined
  return {
    type: "run-failed",
    reason: tag ?? "internal",
    retryable: tag !== undefined && RETRYABLE.has(tag),
  }
}

/**
 * Bracket a run: `run-started` first, then the body, then exactly one
 * terminal on every exit path. The body's own terminal (e.g.
 * `run-interrupted`) wins and ends the run; otherwise success emits
 * `run-completed`, `stopWhen` emits `run-stopped`, interruption emits
 * `run-stopped`, and a failure emits `run-failed` (the error is absorbed).
 */
export const withTerminal =
  (options: RunOptions) =>
  <E, R>(self: Stream.Stream<RunEvent, E, R>): Stream.Stream<RunEvent, never, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ended = yield* Ref.make(false)
        const stopped = yield* Ref.make(false)
        const started: RunEvent = {
          type: "run-started",
          runId: options.runId,
          messageId: options.messageId ?? options.runId,
          inputs: options.inputs ?? [],
          protocol: PROTOCOL_VERSION,
          ...(options.name !== undefined ? { name: options.name } : {}),
        }
        const watched = self.pipe(
          Stream.takeUntil(isTerminal),
          Stream.tap((event) => (isTerminal(event) ? Ref.set(ended, true) : Effect.void)),
        )
        const stoppable =
          options.stopWhen === undefined
            ? watched
            : watched.pipe(
                Stream.interruptWhen(options.stopWhen.pipe(Effect.andThen(Ref.set(stopped, true)))),
              )
        const body = stoppable.pipe(
          Stream.catchCause((cause) =>
            Stream.fromEffect(
              Ref.set(ended, true).pipe(
                Effect.as<RunEvent>(
                  Cause.hasInterruptsOnly(cause) ? { type: "run-stopped" } : failed(cause),
                ),
              ),
            ),
          ),
        )
        const terminal = Stream.unwrap(
          Effect.all([Ref.get(ended), Ref.get(stopped)]).pipe(
            Effect.map(([isEnded, isStopped]) =>
              isEnded
                ? Stream.empty
                : Stream.succeed<RunEvent>(
                    isStopped ? { type: "run-stopped", by: "user" } : { type: "run-completed" },
                  ),
            ),
          ),
        )
        return Stream.succeed(started).pipe(Stream.concat(body), Stream.concat(terminal))
      }),
    )

// ---------------------------------------------------------------------------
// coalesce
// ---------------------------------------------------------------------------

const merge = (a: RunEvent, b: RunEvent): RunEvent | undefined => {
  if (a.type === "text-delta" && b.type === "text-delta") return { ...a, text: a.text + b.text }
  if (a.type === "reasoning-delta" && b.type === "reasoning-delta" && a.kind === b.kind) {
    return { ...a, text: a.text + b.text }
  }
  if (
    a.type === "tool-call-args-delta" &&
    b.type === "tool-call-args-delta" &&
    a.callId === b.callId
  ) {
    return { ...a, delta: a.delta + b.delta }
  }
  return undefined
}

const mergeAdjacent = (group: ReadonlyArray<RunEvent>): ReadonlyArray<RunEvent> =>
  Arr.reduce(group, Arr.empty<RunEvent>(), (acc: ReadonlyArray<RunEvent>, event) => {
    const last = acc.at(-1)
    const merged = last === undefined ? undefined : merge(last, event)
    return merged === undefined ? [...acc, event] : [...acc.slice(0, -1), merged]
  })

/**
 * Merge consecutive text, reasoning and tool-argument deltas that arrive
 * within `window`; every other event passes through unchanged and in order.
 * Bounds frames on the wire and rows in a durable log; adds up to `window`
 * latency.
 */
export const coalesce =
  (window: Duration.Input) =>
  <E, R>(self: Stream.Stream<RunEvent, E, R>): Stream.Stream<RunEvent, E, R> =>
    self.pipe(
      Stream.groupedWithin(1024, window),
      Stream.flatMap((group) => Stream.fromIterable(mergeAdjacent(group))),
    )
