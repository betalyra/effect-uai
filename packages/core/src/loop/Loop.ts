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
import {
  Array as Arr,
  Cause,
  Channel,
  Data,
  Effect,
  Exit,
  Function,
  Match,
  Option,
  Ref,
  Result,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { IncompleteTurn } from "../domain/AiError.js"
import { isTurnComplete, type Turn, type TurnEvent } from "../domain/Turn.js"

// ---------------------------------------------------------------------------
// Event type - the body's emit shape
// ---------------------------------------------------------------------------

/**
 * The tagged union a body emits per pull. `Value` carries a payload that
 * flows downstream. `Next` ends the current iteration and continues with a
 * new state. `Stop` ends the loop entirely; it optionally carries a final
 * state that `loopFrom` will thread to the next input and `loopWithState`
 * will write to its `SubscriptionRef` before the loop ends. Plain `loop`
 * has no next iteration to apply it to and ignores the state.
 */
export type Event<A, S> = Data.TaggedEnum<{
  Value: { readonly value: A }
  Next: { readonly state: S }
  Stop: { readonly state: Option.Option<S> }
}>

interface EventDef extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: Event<this["A"], this["B"]>
}

const Event = Data.taggedEnum<EventDef>()

/** Wrap a value so it flows through the loop to downstream consumers. */
export const value = <A>(a: A): Event<A, never> => Event.Value({ value: a })

/** End the current iteration and continue with a new state. */
export const next = <S>(state: S): Event<never, S> => Event.Next({ state })

/**
 * The terminal `Stop` event with no carried state. Use `stop` (the Stream)
 * to end a loop body without communicating a final state.
 */
export const stopEvent: Event<never, never> = Event.Stop({ state: Option.none() })

/**
 * Terminal `Stop` event that also carries a final state. For `loopFrom`
 * this is the natural "this input is done, here's the state to carry
 * forward to the next input" signal — symmetric with `next(s)` but ending
 * the inner loop instead of continuing it.
 */
export const stopWith = <S>(state: S): Event<never, S> => Event.Stop({ state: Option.some(state) })

/**
 * A single-element stream that ends the loop. Return this from a body when
 * there's nothing else to emit; equivalent to `stopAfter(Stream.empty)` but
 * named for the common case.
 */
export const stop: Stream.Stream<Event<never, never>> = Stream.succeed(stopEvent)

/**
 * Pipe a raw `Stream<A>` into the loop's emit shape, then terminate the
 * iteration with `next(state)`. Common shape for "stream this turn's
 * deltas, then continue with updated history."
 *
 * Dual: data-first `nextAfter(stream, state)` and data-last
 * `stream.pipe(nextAfter(state))` both work.
 */
export const nextAfter: {
  <S>(state: S): <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<Event<A, S>, E, R>
  <S, A, E, R>(stream: Stream.Stream<A, E, R>, state: S): Stream.Stream<Event<A, S>, E, R>
} = Function.dual(
  2,
  <S, A, E, R>(stream: Stream.Stream<A, E, R>, state: S): Stream.Stream<Event<A, S>, E, R> =>
    Stream.concat(Stream.map(stream, value), Stream.fromIterable([next(state)])),
)

/**
 * Pipe a raw `Stream<A>` into the loop's emit shape, then terminate the
 * loop. Common shape for "stream this turn's deltas, then we're done."
 *
 * Unary on the stream — already pipe-compatible via `stream.pipe(stopAfter)`.
 */
export const stopAfter = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<Event<A, never>, E, R> =>
  Stream.concat(Stream.map(stream, value), Stream.fromIterable([stopEvent]))

/**
 * Pipe a raw `Stream<A>` into the loop's emit shape, then terminate with
 * `stopWith(state)`. The natural "emit final outputs, advance state, end
 * this input's inner loop" shape for `loopFrom`.
 *
 * Dual: data-first `stopWithAfter(stream, state)` and data-last
 * `stream.pipe(stopWithAfter(state))` both work.
 */
export const stopWithAfter: {
  <S>(state: S): <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<Event<A, S>, E, R>
  <S, A, E, R>(stream: Stream.Stream<A, E, R>, state: S): Stream.Stream<Event<A, S>, E, R>
} = Function.dual(
  2,
  <S, A, E, R>(stream: Stream.Stream<A, E, R>, state: S): Stream.Stream<Event<A, S>, E, R> =>
    Stream.concat(Stream.map(stream, value), Stream.fromIterable([stopWith(state)])),
)

/**
 * General `nextAfter` variant: drain `stream` to the consumer, fold elements
 * into an accumulator, and at end-of-stream emit one `next(build(finalAcc))`.
 *
 * Subsumes `nextAfter` when state is constant (`reduce: (s, _) => s`,
 * `build: (s) => s`). Used by `Toolkit.continueWith` to collect tool
 * results and build next state without exposing a Ref to recipes.
 *
 * Dual: data-first `nextAfterFold(stream, initial, reduce, build)` and
 * data-last `stream.pipe(nextAfterFold(initial, reduce, build))` both work.
 */
export const nextAfterFold: {
  <A, B, S>(
    initial: B,
    reduce: (acc: B, a: A) => B,
    build: (b: B) => S,
  ): <E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<Event<A, S>, E, R>
  <A, B, S, E, R>(
    stream: Stream.Stream<A, E, R>,
    initial: B,
    reduce: (acc: B, a: A) => B,
    build: (b: B) => S,
  ): Stream.Stream<Event<A, S>, E, R>
} = Function.dual(
  4,
  <A, B, S, E, R>(
    stream: Stream.Stream<A, E, R>,
    initial: B,
    reduce: (acc: B, a: A) => B,
    build: (b: B) => S,
  ): Stream.Stream<Event<A, S>, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ref = yield* Ref.make(initial)
        const tapped = stream.pipe(
          Stream.tap((a) => Ref.update(ref, (acc) => reduce(acc, a))),
          Stream.map(value),
        )
        const continuation = Stream.fromEffect(
          Ref.get(ref).pipe(Effect.map((acc) => next(build(acc)))),
        )
        return tapped.pipe(Stream.concat(continuation))
      }),
    ),
)

// ---------------------------------------------------------------------------
// onTurnComplete - turn-aware stream operator for loop bodies
// ---------------------------------------------------------------------------

/**
 * Lift a provider's `Stream<TurnEvent>` into a loop body's `Stream<Event<TurnEvent | A, S>>`.
 * Each delta passes through as `value(delta)` (including the terminal
 * `turn_complete`, so the consumer sees turn boundaries naturally). Once
 * the terminal arrives, `then(turn)` runs and its returned stream of loop
 * events (typically tool outputs followed by `next(state)` or `stop`) is
 * concatenated.
 *
 * Pre-pipe transforms (`Stream.tap` / `Stream.map` / `Stream.filter`) on
 * the raw delta stream cover anything an `emit`-style callback would do.
 *
 * If the upstream ends without a `turn_complete`, the resulting stream
 * fails with `AiError.IncompleteTurn`. Catch it via `Stream.catchTag` if
 * you want to recover.
 *
 * Dual: data-first `onTurnComplete(deltas, then)` and data-last
 * `deltas.pipe(onTurnComplete(then))` both work.
 */
export const onTurnComplete: {
  <S, A, E2 = never, R2 = never>(
    then: (turn: Turn) => Effect.Effect<Stream.Stream<Event<A, S>, E2, R2>, E2, R2>,
  ): <E, R>(
    deltas: Stream.Stream<TurnEvent, E, R>,
  ) => Stream.Stream<Event<TurnEvent | A, S>, E | E2 | IncompleteTurn, R | R2>
  <S, A, E, R, E2 = never, R2 = never>(
    deltas: Stream.Stream<TurnEvent, E, R>,
    then: (turn: Turn) => Effect.Effect<Stream.Stream<Event<A, S>, E2, R2>, E2, R2>,
  ): Stream.Stream<Event<TurnEvent | A, S>, E | E2 | IncompleteTurn, R | R2>
} = Function.dual(
  2,
  <S, A, E, R, E2, R2>(
    deltas: Stream.Stream<TurnEvent, E, R>,
    then: (turn: Turn) => Effect.Effect<Stream.Stream<Event<A, S>, E2, R2>, E2, R2>,
  ): Stream.Stream<Event<TurnEvent | A, S>, E | E2 | IncompleteTurn, R | R2> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const turnRef = yield* Ref.make<Option.Option<Turn>>(Option.none())

        const events: Stream.Stream<Event<TurnEvent, S>, E, R> = deltas.pipe(
          Stream.tap((delta) =>
            isTurnComplete(delta) ? Ref.set(turnRef, Option.some(delta.turn)) : Effect.void,
          ),
          Stream.map(value),
        )

        const continuation = Stream.unwrap(
          Effect.gen(function* () {
            const opt = yield* Ref.get(turnRef)
            if (Option.isNone(opt)) return yield* Effect.fail(new IncompleteTurn({}))
            return yield* then(opt.value)
          }),
        )

        return Stream.concat(events, continuation)
      }),
    ),
)

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const isNonEmpty = <A>(array: ReadonlyArray<A>): array is readonly [A, ...Array<A>] =>
  array.length > 0

type CurrentBody<S, A, E, R> = {
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
): {
  readonly values: ReadonlyArray<A>
  readonly decision: Option.Option<Event<A, S>>
} => {
  const [valueEvents, rest] = Arr.span(
    chunk,
    (e): e is Event<A, S> & { _tag: "Value" } => e._tag === "Value",
  )
  return {
    values: valueEvents.map((e) => e.value),
    decision: Arr.head(rest),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type LoopBody<S, A, E, R> = (
  state: S,
) => Stream.Stream<Event<A, S>, E, R> | Effect.Effect<Stream.Stream<Event<A, S>, E, R>, E, R>

/**
 * Drive a state-threaded loop body. Each iteration runs `body(state)` to get
 * a `Stream<Event<A, S>>`; values flow downstream, `next(s)` continues with
 * a new state, `stop` ends the loop. See the file header for the full
 * pull-based execution model.
 *
 * Dual: data-first `loop(initial, body)` and data-last `loop(body)(initial)`
 * (or `pipe(initial, loop(body))`) both work.
 */
export const loop: {
  <S, A, E, R>(body: LoopBody<S, A, E, R>): (initial: S) => Stream.Stream<A, E, R>
  <S, A, E, R>(initial: S, body: LoopBody<S, A, E, R>): Stream.Stream<A, E, R>
} = Function.dual(
  2,
  <S, A, E, R>(initial: S, body: LoopBody<S, A, E, R>): Stream.Stream<A, E, R> =>
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
                ).pipe(Effect.onError((cause) => Scope.close(bodyScope, Exit.failCause(cause))))
                current = { scope: bodyScope, pull: bodyPull }
              }

              const active = current
              const chunk = yield* active.pull.pipe(
                Effect.catchIf(Cause.isDone, () =>
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

              if (Option.isSome(decision)) {
                yield* closeActive(active, Exit.void)
                if (decision.value._tag === "Stop") {
                  done = true
                } else if (decision.value._tag === "Next") {
                  state = decision.value.state
                }
              }

              // Emit the values seen so far if any. Chunks from a Stream pull
              // are non-empty, so when `decision` is `None` every event was
              // a `Value` and `values` is non-empty here. With a decision and
              // no preceding values, fall through to the next iteration.
              if (isNonEmpty(values)) return values
            }
          })

          return pull
        }),
      ),
    ),
)

// ---------------------------------------------------------------------------
// loopFrom - stream-driven sibling of loop. One input item runs a full
// multi-turn inner loop.
// ---------------------------------------------------------------------------

type LoopFromBody<S, I, A, E, R> = (
  state: S,
  input: I,
) => Stream.Stream<Event<A, S>, E, R> | Effect.Effect<Stream.Stream<Event<A, S>, E, R>, E, R>

/**
 * Input-driven sibling of `loop`. For each item pulled from the input
 * stream, runs an inner seed-driven `loop` whose body is
 * `(s) => body(s, item)`. State is threaded across input items.
 *
 * **Per-input semantics — the body emits standard `Event<A, S>`:**
 *   - `value(a)`: emit `a` downstream
 *   - `next(s)`: re-run the body with the SAME input and new state `s`
 *     (multi-turn within one input — e.g. multiple model turns + tool
 *     calls for one document)
 *   - `stop`: end this input's inner loop, advance to the next input
 *     (state preserved)
 *   - body stream ending without a decision: same as `stop` (advance)
 *
 * **Outer termination:** the input stream ending. To halt programmatically
 * from within, end the input stream upstream (`Stream.takeWhile`, a
 * `SubscriptionRef` gate, etc.). Reserving `stop` for per-item
 * advancement is what makes the common "stream of documents, multi-turn
 * conversation per document" shape readable.
 *
 * Dual: data-first `loopFrom(input, initial, body)` and data-last
 * `input.pipe(loopFrom(initial, body))` both work.
 */
export const loopFrom: {
  <S, I, A, E, R>(
    initial: S,
    body: LoopFromBody<S, I, A, E, R>,
  ): <EI, RI>(input: Stream.Stream<I, EI, RI>) => Stream.Stream<A, E | EI, R | RI>
  <S, I, A, E, R, EI, RI>(
    input: Stream.Stream<I, EI, RI>,
    initial: S,
    body: LoopFromBody<S, I, A, E, R>,
  ): Stream.Stream<A, E | EI, R | RI>
} = Function.dual(
  3,
  <S, I, A, E, R, EI, RI>(
    input: Stream.Stream<I, EI, RI>,
    initial: S,
    body: LoopFromBody<S, I, A, E, R>,
  ): Stream.Stream<A, E | EI, R | RI> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const stateRef = yield* Ref.make<S>(initial)
        return input.pipe(
          Stream.flatMap((item) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const state = yield* Ref.get(stateRef)
                // Capture Next states (and stopWith's final state) into the
                // outer ref so the LAST state seen in this input's inner
                // loop is what the next input starts from.
                const wrappedBody = (s: S) => {
                  const result = body(s, item)
                  const stream = Effect.isEffect(result) ? Stream.unwrap(result) : result
                  return stream.pipe(
                    Stream.tap((event) =>
                      Match.value(event).pipe(
                        Match.tag("Next", (e) => Ref.set(stateRef, e.state)),
                        Match.tag("Stop", (e) =>
                          Option.match(e.state, {
                            onSome: (s) => Ref.set(stateRef, s),
                            onNone: () => Effect.void,
                          }),
                        ),
                        Match.orElse(() => Effect.void),
                      ),
                    ),
                  )
                }
                return loop(state, wrappedBody)
              }),
            ),
          ),
        )
      }),
    ),
)

// ---------------------------------------------------------------------------
// loopWithState - same body protocol, plus a live state observable.
// ---------------------------------------------------------------------------

/**
 * Like `loop`, but exposes the current loop state as a `SubscriptionRef`
 * alongside the value stream.
 *
 * Allocates one `SubscriptionRef<S>` seeded with `initial`, then runs the
 * loop with a wrapped body that taps every `Next(s)` event into the ref
 * before forwarding it. The caller decides how to consume both channels:
 *
 *   - **Final state**: drain the stream, then `SubscriptionRef.get(state)`
 *     - the ref holds the state from the last `Next` (or `initial` if the
 *     loop ended without advancing).
 *   - **Live transitions**: `SubscriptionRef.changes(state)` is a
 *     `Stream<S>` of every state observed; subscribe alongside the value
 *     stream.
 *   - **Mid-iteration peek**: `SubscriptionRef.get(state)` at any time.
 *
 * The returned stream and ref are independent of each other - the ref
 * lives outside the stream's scope, so reading it after the stream
 * completes is safe.
 */
export const loopWithState = <S, A, E, R>(
  initial: S,
  body: LoopBody<S, A, E, R>,
): Effect.Effect<{
  readonly stream: Stream.Stream<A, E, R>
  readonly state: SubscriptionRef.SubscriptionRef<S>
}> =>
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(initial)

    const tap = (stream: Stream.Stream<Event<A, S>, E, R>): Stream.Stream<Event<A, S>, E, R> =>
      stream.pipe(
        Stream.tap((event) =>
          Match.value(event).pipe(
            Match.tag("Next", (e) => SubscriptionRef.set(stateRef, e.state)),
            Match.tag("Stop", (e) =>
              Option.match(e.state, {
                onSome: (s) => SubscriptionRef.set(stateRef, s),
                onNone: () => Effect.void,
              }),
            ),
            Match.orElse(() => Effect.void),
          ),
        ),
      )

    const wrappedBody: LoopBody<S, A, E, R> = (s) => {
      const result = body(s)
      return Effect.isEffect(result) ? Effect.map(result, tap) : tap(result)
    }

    return {
      stream: loop(initial, wrappedBody),
      state: stateRef,
    }
  })
