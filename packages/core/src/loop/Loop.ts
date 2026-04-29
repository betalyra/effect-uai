/**
 * Pull-based `loop` for state-threaded sub-streams.
 *
 * Each iteration runs a body that returns a `Stream<Event<A, S>>`. The body
 * emits values via `Loop.value(a)` and signals iteration control via
 * `Loop.next(state)` (continue with new state) or `Loop.stop` (terminate).
 * The loop unwraps `Value` events back to `A` for downstream consumers, so
 * the resulting stream is a plain `Stream<A>`.
 *
 * The next body stream is only pulled when downstream pulls the outer
 * stream - no producer fiber, no queue buffering. Cancellation, failures,
 * scoped resources, and backpressure stay aligned with normal Stream
 * semantics.
 *
 * Convention: a `Next` or `Stop` event is the terminal element of a body's
 * iteration. Values emitted in the same chunk after one are discarded
 * (their producing side effects may already have run). Prefer the
 * `Loop.nextAfter` / `Loop.stopAfter` helpers to terminate cleanly.
 */
import { Cause, Channel, Data, Effect, Exit, Scope, Stream } from "effect"

// ---------------------------------------------------------------------------
// Event type - the body's emit shape
// ---------------------------------------------------------------------------

/**
 * The tagged union a body emits per pull. `Value` carries a payload that
 * flows downstream. `Next` ends the current iteration and continues with a
 * new state. `Stop` ends the loop entirely.
 */
export type Event<A, S> = Data.TaggedEnum<{
  Value: { readonly value: A }
  Next: { readonly state: S }
  Stop: {}
}>

interface EventDef extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: Event<this["A"], this["B"]>
}

const Event = Data.taggedEnum<EventDef>()

/** Wrap a value so it flows through the loop to downstream consumers. */
export const value = <A>(a: A): Event<A, never> => Event.Value({ value: a })

/** End the current iteration and continue with a new state. */
export const next = <S>(state: S): Event<never, S> => Event.Next({ state })

/** End the loop entirely. */
export const stop: Event<never, never> = Event.Stop()

/**
 * Pipe a raw `Stream<A>` into the loop's emit shape, then terminate the
 * iteration with `next(state)`. Common shape for "stream this turn's
 * deltas, then continue with updated history."
 */
export const nextAfter = <S, A, E, R>(
  stream: Stream.Stream<A, E, R>,
  state: S,
): Stream.Stream<Event<A, S>, E, R> =>
  Stream.concat(Stream.map(stream, value), Stream.fromIterable([next(state)]))

/**
 * Pipe a raw `Stream<A>` into the loop's emit shape, then terminate the
 * loop. Common shape for "stream this turn's deltas, then we're done."
 */
export const stopAfter = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<Event<A, never>, E, R> =>
  Stream.concat(Stream.map(stream, value), Stream.fromIterable([stop]))

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const isNonEmpty = <A>(array: ReadonlyArray<A>): array is readonly [A, ...Array<A>] =>
  array.length > 0

interface CurrentBody<S, A, E, R> {
  readonly scope: Scope.Closeable
  readonly pull: Effect.Effect<ReadonlyArray<Event<A, S>>, E | Cause.Done<void>, R>
}

const closeBody = <S, A, E, R>(
  current: CurrentBody<S, A, E, R>,
  exit: Exit.Exit<unknown, unknown>,
) => Scope.close(current.scope, exit)

/**
 * Walk a chunk of `Event<A, S>` until a terminal `Next` or `Stop` is found.
 * Returns the unwrapped values seen so far and (optionally) the terminal
 * event. Anything in the chunk after the terminal is discarded - its
 * producing side effects may have run, but downstream never sees it.
 */
const partitionChunk = <A, S>(
  chunk: ReadonlyArray<Event<A, S>>,
): { readonly values: Array<A>; readonly decision: Event<A, S> | undefined } => {
  const values: Array<A> = []
  for (let i = 0; i < chunk.length; i++) {
    const event = chunk[i]!
    if (event._tag === "Value") {
      values.push(event.value)
    } else {
      return { values, decision: event }
    }
  }
  return { values, decision: undefined }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const loop = <S, A, E, R>(
  initial: S,
  body: (
    state: S,
  ) =>
    | Stream.Stream<Event<A, S>, E, R>
    | Effect.Effect<Stream.Stream<Event<A, S>, E, R>, E, R>,
): Stream.Stream<A, E, R> =>
  Stream.scoped(
    Stream.fromPull(
      Effect.gen(function* () {
        const outerScope = yield* Effect.scope
        let state = initial
        let current: CurrentBody<S, A, E, R> | undefined
        let done = false

        const closeActive = (
          active: CurrentBody<S, A, E, R>,
          exit: Exit.Exit<unknown, unknown>,
        ) => {
          const isActive = current === active
          if (isActive) current = undefined
          // Scope.close is idempotent. Multiple paths can race to close the
          // active body during cancellation/failure, so closing twice is safe.
          return closeBody(active, exit)
        }

        yield* Scope.addFinalizerExit(outerScope, (exit) =>
          current === undefined ? Effect.void : closeActive(current, exit),
        )

        const pull = Effect.gen(function* () {
          while (true) {
            if (done) return yield* Cause.done()

            if (current === undefined) {
              const result = body(state)
              const stream = Effect.isEffect(result) ? Stream.unwrap(result) : result
              const bodyScope = yield* Scope.fork(outerScope)
              const bodyPull = yield* Channel.toPullScoped(
                Stream.toChannel(stream),
                bodyScope,
              ).pipe(
                Effect.onError((cause) => Scope.close(bodyScope, Exit.failCause(cause))),
              )
              current = { scope: bodyScope, pull: bodyPull }
            }

            const active = current
            const chunk = yield* active.pull.pipe(
              Effect.catchIf(
                Cause.isDone,
                () =>
                  closeActive(active, Exit.void).pipe(
                    Effect.as(undefined as ReadonlyArray<Event<A, S>> | undefined),
                  ),
              ),
              Effect.onError((cause) => closeActive(active, Exit.failCause(cause))),
            )

            if (chunk === undefined) {
              done = true
              return yield* Cause.done()
            }

            const { values, decision } = partitionChunk(chunk)

            if (decision !== undefined) {
              yield* closeActive(active, Exit.void)
              if (decision._tag === "Stop") {
                done = true
              } else if (decision._tag === "Next") {
                state = decision.state
              }
            }

            // Emit the values seen so far if any. Chunks from a Stream pull
            // are non-empty, so when `decision === undefined` every event was
            // a `Value` and `values` is non-empty here. With a decision and
            // no preceding values, fall through to the next iteration.
            if (isNonEmpty(values)) return values
          }
        })

        return pull
      }),
    ),
  )
