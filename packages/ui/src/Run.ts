/**
 * Server-side stream operators for runs. Each does one thing; a run pipes
 * the ones it needs:
 *
 *   agent(history).pipe(
 *     Projection.toRunEvents(),
 *     Run.coalesce("30 millis"),
 *     Stream.catchCause((cause) => Stream.succeed(Run.failed(cause))),
 *     Run.stopWhen(Deferred.await(stop)), // durable runs
 *     Run.complete,
 *     Run.start({ runId, inputs }),
 *     Run.sequence(streamId),
 *   )
 *
 * In this order they keep the protocol's rule: `run-started` first, exactly
 * one terminal last. Direct mode needs no stop: when the client goes away,
 * the server interrupts the stream (Effect's `HttpServer`, or
 * `HttpRouter.toWebHandler` behind a framework's route).
 */
import { Array as Arr, Cause, Effect, Predicate, Schema, Stream } from "effect"
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
// A run's frame: start, stop, failure, completion
// ---------------------------------------------------------------------------

export type StartOptions = {
  readonly runId: RunId
  /** Client input ids the run answers. */
  readonly inputs?: ReadonlyArray<InputId>
  /** Role label when a stream carries several kinds of run. */
  readonly name?: string
}

/** Prepend `run-started`. */
export const start =
  (options: StartOptions) =>
  <E, R>(self: Stream.Stream<RunEvent, E, R>): Stream.Stream<RunEvent, E, R> => {
    const started: RunEvent = {
      type: "run-started",
      runId: options.runId,
      inputs: options.inputs ?? [],
      protocol: PROTOCOL_VERSION,
      ...(options.name !== undefined ? { name: options.name } : {}),
    }
    return Stream.make(started).pipe(Stream.concat(self))
  }

/** End the run at its first terminal; append `run-completed` if it ends without one. */
export const complete = <E, R>(
  self: Stream.Stream<RunEvent, E, R>,
): Stream.Stream<RunEvent, E, R> =>
  self.pipe(
    Stream.takeUntil(isTerminal),
    Stream.mapAccum(
      () => false,
      (ended, event): readonly [boolean, ReadonlyArray<RunEvent>] => [
        ended || isTerminal(event),
        [event],
      ],
      { onHalt: (ended): ReadonlyArray<RunEvent> => (ended ? [] : [{ type: "run-completed" }]) },
    ),
  )

/** End the run with `run-stopped` when `signal` completes (e.g. a stop `Deferred`). */
export const stopWhen =
  (signal: Effect.Effect<void>) =>
  <E, R>(self: Stream.Stream<RunEvent, E, R>): Stream.Stream<RunEvent, E, R> =>
    self.pipe(
      Stream.merge(Stream.fromEffect(Effect.as(signal, { type: "run-stopped" } as const)), {
        haltStrategy: "left",
      }),
      Stream.takeUntil((event) => event.type === "run-stopped"),
    )

/** A `run-failed` for a failed stream: `reason` is the error's `_tag`, else `"internal"`. */
export const failed = (cause: Cause.Cause<unknown>): RunEvent => {
  const error = Cause.squash(cause)
  const reason =
    Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : "internal"
  return { type: "run-failed", reason }
}

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
// coalesce
// ---------------------------------------------------------------------------

const merge = (a: RunEvent, b: RunEvent): RunEvent | undefined => {
  if (a.type === "text-delta" && b.type === "text-delta") return { ...a, text: a.text + b.text }
  if (a.type === "refusal-delta" && b.type === "refusal-delta")
    return { ...a, text: a.text + b.text }
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
