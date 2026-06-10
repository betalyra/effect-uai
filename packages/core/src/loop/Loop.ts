/**
 * Pull-based `loop` for state-threaded sub-streams.
 *
 * Each iteration runs a body that returns a `Stream<Step<A, S>>`. The body
 * emits values via `Loop.value(a)` and signals iteration control via
 * `Loop.next(state)` (continue with new state) or `Loop.stop()` (terminate).
 * The loop unwraps `Value` steps back to `A` for downstream consumers, so
 * the resulting stream is a plain `Stream<A>`.
 *
 * The next body stream is only pulled when downstream pulls the outer
 * stream - no producer fiber, no queue buffering. Cancellation, failures,
 * scoped resources, and backpressure stay aligned with normal Stream
 * semantics.
 *
 * Convention: a `Next` or `Stop` step is the terminal element of a body's
 * iteration. Values emitted in the same chunk after one are discarded
 * (their producing side effects may already have run). The `Loop.next` /
 * `Loop.stop` helpers each emit a single terminal step, so concatenate
 * your values before them (`values.pipe(Stream.concat(Loop.next(state)))`).
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
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { IncompleteTurn } from "../domain/AiError.js"
import { isTurnComplete, type Turn, type TurnEvent } from "../domain/Turn.js"

// ---------------------------------------------------------------------------
// Step type - the body's emit shape
// ---------------------------------------------------------------------------

/**
 * The tagged union a body emits per pull. `Value` carries a payload that
 * flows downstream. `Next` ends the current iteration and continues with a
 * new state. `Stop` ends the loop entirely with no carried state.
 * `StopWith` also ends the loop but carries a final state that `loopOver`
 * will thread to the next input and `loopWithState` will write to its
 * `SubscriptionRef` before the loop ends. Plain `loop` has no next
 * iteration to apply it to and treats `StopWith` like `Stop`.
 *
 * `Stop` is intentionally `{}` so the bare `stop()` helper doesn't
 * constrain `S` from a body's stream type — every body has a `Stop`
 * variant in its union, and forcing `S` to flow through it would break
 * inference whenever the body never uses `next` / `stop(state)`.
 */
export type Step<A, S> = Data.TaggedEnum<{
  Value: { readonly value: A }
  Next: { readonly state: S }
  Stop: {}
  StopWith: { readonly state: S }
}>

interface StepDef extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: Step<this["A"], this["B"]>
}

const Step = Data.taggedEnum<StepDef>()

/**
 * Bare step constructors, so a loop body can emit `Value(...)`, `Next(...)`,
 * `Stop()`, `StopWith(...)` directly inside a `Stream.make(...)` without the
 * `Step.` prefix. (The `Step` object itself can't be exported under that name
 * because it collides with the exported `Step` type.) For the common cases
 * prefer the `value` / `next` / `stop` helpers, which also handle the
 * single-element-stream wrapping for `next` / `stop`.
 */
export const { Value, Next, Stop, StopWith } = Step

/** Wrap a value so it flows through the loop to downstream consumers. */
export const value = <A>(a: A): Step<A, never> => Step.Value({ value: a })

/**
 * End the current iteration and continue with a new state. Emits a single
 * terminal `Next` step as a one-element stream, so it slots directly into a
 * loop body or after a run of values: `values.pipe(Stream.concat(next(s)))`.
 */
export const next = <S>(state: S): Stream.Stream<Step<never, S>> =>
  Stream.succeed(Step.Next({ state }))

/**
 * End the loop. Called with no argument it emits a bare `Stop`; called with
 * a state it emits `StopWith(state)` — `loopOver` threads that final state
 * to the next input and `loopWithState` writes it to its `SubscriptionRef`
 * before the loop ends. Either way it returns a single-element stream, so
 * return it directly from a loop body.
 */
export const stop = <S = never>(state?: S): Stream.Stream<Step<never, S>> =>
  Stream.succeed<Step<never, S>>(state === undefined ? Step.Stop() : Step.StopWith({ state }))

// ---------------------------------------------------------------------------
// onTurnComplete - turn-aware stream operator for loop bodies
// ---------------------------------------------------------------------------

/**
 * Lift a provider's `Stream<TurnEvent>` into a loop body's `Stream<Step<TurnEvent | A, S>>`.
 * Each delta passes through as `value(delta)` (including the terminal
 * `TurnComplete`, so the consumer sees turn boundaries naturally). Once
 * the terminal arrives, `then(turn)` runs and its returned stream of loop
 * steps (typically tool outputs followed by `next(state)` or `stop()`) is
 * concatenated.
 *
 * Pre-pipe transforms (`Stream.tap` / `Stream.map` / `Stream.filter`) on
 * the raw delta stream cover anything an `emit`-style callback would do.
 *
 * `then` may return the step stream directly, or an `Effect` that produces
 * it (for branches that need to read a `Ref`, decode tool args, log, etc.).
 * Mirrors `loop`'s body: return a bare `stop()` / `next(s)` where no effect
 * is needed, lift to `Effect` only where one is.
 *
 * If the upstream ends without a `TurnComplete`, the resulting stream
 * fails with `AiError.IncompleteTurn`. Catch it via `Stream.catchTag` if
 * you want to recover.
 *
 * Dual: data-first `onTurnComplete(deltas, then)` and data-last
 * `deltas.pipe(onTurnComplete(then))` both work.
 */
type TurnContinuation<S, A, E2, R2> =
  | Stream.Stream<Step<A, S>, E2, R2>
  | Effect.Effect<Stream.Stream<Step<A, S>, E2, R2>, E2, R2>

export const onTurnComplete: {
  <S, A, E2 = never, R2 = never>(
    then: (turn: Turn) => TurnContinuation<S, A, E2, R2>,
  ): <E, R>(
    deltas: Stream.Stream<TurnEvent, E, R>,
  ) => Stream.Stream<Step<TurnEvent | A, S>, E | E2 | IncompleteTurn, R | R2>
  <S, A, E, R, E2 = never, R2 = never>(
    deltas: Stream.Stream<TurnEvent, E, R>,
    then: (turn: Turn) => TurnContinuation<S, A, E2, R2>,
  ): Stream.Stream<Step<TurnEvent | A, S>, E | E2 | IncompleteTurn, R | R2>
} = Function.dual(
  2,
  <S, A, E, R, E2, R2>(
    deltas: Stream.Stream<TurnEvent, E, R>,
    then: (turn: Turn) => TurnContinuation<S, A, E2, R2>,
  ): Stream.Stream<Step<TurnEvent | A, S>, E | E2 | IncompleteTurn, R | R2> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const turnRef = yield* Ref.make<Option.Option<Turn>>(Option.none())

        const events: Stream.Stream<Step<TurnEvent, S>, E, R> = deltas.pipe(
          Stream.tap((delta) =>
            isTurnComplete(delta) ? Ref.set(turnRef, Option.some(delta.turn)) : Effect.void,
          ),
          Stream.map(value),
        )

        const continuation = Stream.unwrap(
          Effect.gen(function* () {
            const opt = yield* Ref.get(turnRef)
            if (Option.isNone(opt)) return yield* new IncompleteTurn({})
            const result = then(opt.value)
            return Effect.isEffect(result) ? yield* result : result
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
  readonly pull: Effect.Effect<ReadonlyArray<Step<A, S>>, E | Cause.Done<void>, R>
}

const closeBody = <S, A, E, R>(
  current: CurrentBody<S, A, E, R>,
  exit: Exit.Exit<unknown, unknown>,
) => Scope.close(current.scope, exit)

/**
 * Walk a chunk of `Step<A, S>` until a terminal `Next` or `Stop` is found.
 * Returns the unwrapped values seen so far and (optionally) the terminal
 * step. Anything in the chunk after the terminal is discarded - its
 * producing side effects may have run, but downstream never sees it.
 */
const partitionChunk = <A, S>(
  chunk: ReadonlyArray<Step<A, S>>,
): {
  readonly values: ReadonlyArray<A>
  readonly decision: Option.Option<Step<A, S>>
} => {
  const [valueSteps, rest] = Arr.span(
    chunk,
    (e): e is Step<A, S> & { _tag: "Value" } => e._tag === "Value",
  )
  return {
    values: valueSteps.map((e) => e.value),
    decision: Arr.head(rest),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type LoopBody<S, A, E, R> = (
  state: S,
) => Stream.Stream<Step<A, S>, E, R> | Effect.Effect<Stream.Stream<Step<A, S>, E, R>, E, R>

/**
 * Drive a state-threaded loop body. Each iteration runs `body(state)` to get
 * a `Stream<Step<A, S>>`; values flow downstream, `next(s)` continues with
 * a new state, `stop()` ends the loop. See the file header for the full
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
                    Effect.as(undefined as ReadonlyArray<Step<A, S>> | undefined),
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
                if (decision.value._tag === "Stop" || decision.value._tag === "StopWith") {
                  // `loop` has no next iteration to apply StopWith's state to;
                  // the state lands in `loopOver`'s outer ref or
                  // `loopWithState`'s SubscriptionRef via their taps.
                  done = true
                } else if (decision.value._tag === "Next") {
                  state = decision.value.state
                }
              }

              // Emit the values seen so far if any. Chunks from a Stream pull
              // are non-empty, so when `decision` is `None` every step was
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
// loopOver - stream-driven sibling of loop. One input item runs a full
// multi-turn inner loop.
// ---------------------------------------------------------------------------

type LoopOverBody<S, I, A, E, R> = (
  state: S,
  input: I,
) => Stream.Stream<Step<A, S>, E, R> | Effect.Effect<Stream.Stream<Step<A, S>, E, R>, E, R>

/**
 * Input-driven sibling of `loop`. For each item pulled from the input
 * stream, runs an inner seed-driven `loop` whose body is
 * `(s) => body(s, item)`. State is threaded across input items.
 *
 * **Per-input semantics — the body emits standard `Step<A, S>`:**
 *   - `value(a)`: emit `a` downstream
 *   - `next(s)`: re-run the body with the SAME input and new state `s`
 *     (multi-turn within one input — e.g. multiple model turns + tool
 *     calls for one document)
 *   - `stop()`: end this input's inner loop, advance to the next input
 *     (state preserved)
 *   - body stream ending without a decision: same as `stop()` (advance)
 *
 * **Outer termination:** the input stream ending. To halt programmatically
 * from within, end the input stream upstream (`Stream.takeWhile`, a
 * `SubscriptionRef` gate, etc.). Reserving `stop()` for per-item
 * advancement is what makes the common "stream of documents, multi-turn
 * conversation per document" shape readable.
 *
 * Dual: data-first `loopOver(input, initial, body)` and data-last
 * `input.pipe(loopOver(initial, body))` both work.
 */
export const loopOver: {
  <S, I, A, E, R>(
    initial: S,
    body: LoopOverBody<S, I, A, E, R>,
  ): <EI, RI>(input: Stream.Stream<I, EI, RI>) => Stream.Stream<A, E | EI, R | RI>
  <S, I, A, E, R, EI, RI>(
    input: Stream.Stream<I, EI, RI>,
    initial: S,
    body: LoopOverBody<S, I, A, E, R>,
  ): Stream.Stream<A, E | EI, R | RI>
} = Function.dual(
  3,
  <S, I, A, E, R, EI, RI>(
    input: Stream.Stream<I, EI, RI>,
    initial: S,
    body: LoopOverBody<S, I, A, E, R>,
  ): Stream.Stream<A, E | EI, R | RI> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const stateRef = yield* Ref.make<S>(initial)
        return input.pipe(
          Stream.flatMap((item) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const state = yield* Ref.get(stateRef)
                // Capture Next states (and stop(state)'s final state) into the
                // outer ref so the LAST state seen in this input's inner
                // loop is what the next input starts from.
                const wrappedBody = (s: S) => {
                  const result = body(s, item)
                  const stream = Effect.isEffect(result) ? Stream.unwrap(result) : result
                  return stream.pipe(
                    Stream.tap((step) =>
                      Match.value(step).pipe(
                        Match.tags({
                          Next: (e) => Ref.set(stateRef, e.state),
                          StopWith: (e) => Ref.set(stateRef, e.state),
                        }),
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
 * loop with a wrapped body that taps every `Next(s)` step into the ref
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

    const tap = (stream: Stream.Stream<Step<A, S>, E, R>): Stream.Stream<Step<A, S>, E, R> =>
      stream.pipe(
        Stream.tap((step) =>
          Match.value(step).pipe(
            Match.tags({
              Next: (e) => SubscriptionRef.set(stateRef, e.state),
              StopWith: (e) => SubscriptionRef.set(stateRef, e.state),
            }),
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
