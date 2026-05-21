/**
 * Spike — Stream-combinator reimplementation of Loop.ts.
 *
 * The original `Loop.ts` uses `Stream.fromPull` + `Channel.toPullScoped` to
 * hand-roll pull-based iteration over a state-threaded body. This file
 * expresses the same protocol as a composition of stock Stream combinators:
 *
 *   - `Stream.unfold` produces a stream of per-iteration substreams; halts
 *     when an internal `doneRef` is set.
 *   - Each substream is `body(state)` with a synthetic `stopEvent`
 *     appended (covers "body ended without a decision" => halt).
 *   - `Stream.takeUntil(e => e._tag !== "Value")` short-circuits the
 *     substream the first time a decision event arrives (inclusive — the
 *     decision is the last element).
 *   - `Stream.tap` writes the decision into `stateRef`/`doneRef`.
 *   - `Stream.filterMap` strips the decision so downstream sees `A` only.
 *   - `Stream.flatten` concatenates the iterations sequentially.
 *
 * Event/helper exports re-export `./Loop.js` unchanged — only `loop`,
 * `loopFrom`, `loopWithState` are reimplemented.
 *
 * Status: passes all 33 tests of Loop.test.ts. ~4.1x slower than Loop.ts at
 * the 100k-iteration stress test due to per-element overhead of the
 * tap+filterMap pipeline. Kept on this branch as a reference impl, not for
 * merge. See LoopSpike2.ts for a chunk-aware middle ground (~2.7x slower).
 */
import { Effect, Function, Match, Ref, Result, Stream, SubscriptionRef } from "effect"
import {
  type Event,
  stopEvent,
} from "./Loop.js"

export {
  type Event,
  nextAfter,
  nextAfterFold,
  onTurnComplete,
  stop,
  stopAfter,
  stopEvent,
  stopWith,
  stopWithAfter,
  next,
  value,
} from "./Loop.js"

type LoopBody<S, A, E, R> = (
  state: S,
) => Stream.Stream<Event<A, S>, E, R> | Effect.Effect<Stream.Stream<Event<A, S>, E, R>, E, R>

const reifyBody = <S, A, E, R>(
  result: Stream.Stream<Event<A, S>, E, R> | Effect.Effect<Stream.Stream<Event<A, S>, E, R>, E, R>,
): Stream.Stream<Event<A, S>, E, R> => (Effect.isEffect(result) ? Stream.unwrap(result) : result)

export const loop: {
  <S, A, E, R>(body: LoopBody<S, A, E, R>): (initial: S) => Stream.Stream<A, E, R>
  <S, A, E, R>(initial: S, body: LoopBody<S, A, E, R>): Stream.Stream<A, E, R>
} = Function.dual(
  2,
  <S, A, E, R>(initial: S, body: LoopBody<S, A, E, R>): Stream.Stream<A, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const stateRef = yield* Ref.make<S>(initial)
        const doneRef = yield* Ref.make(false)

        const iterations: Stream.Stream<Stream.Stream<A, E, R>, E, R> = Stream.unfold<
          undefined,
          Stream.Stream<A, E, R>,
          E,
          R
        >(undefined, () =>
          Effect.gen(function* () {
            if (yield* Ref.get(doneRef)) return undefined
            const state = yield* Ref.get(stateRef)
            const raw = reifyBody(body(state))
            const sub: Stream.Stream<A, E, R> = Stream.concat(
              raw,
              Stream.succeed(stopEvent as Event<A, S>),
            ).pipe(
              Stream.takeUntil((e) => e._tag !== "Value"),
              Stream.tap((event) =>
                Match.value(event).pipe(
                  Match.tags({
                    Next: (e) => Ref.set(stateRef, e.state),
                    Stop: () => Ref.set(doneRef, true),
                    StopWith: (e) =>
                      Effect.andThen(Ref.set(stateRef, e.state), Ref.set(doneRef, true)),
                  }),
                  Match.orElse(() => Effect.void),
                ),
              ),
              Stream.filterMap((e: Event<A, S>) =>
                e._tag === "Value" ? Result.succeed(e.value) : Result.fail(e),
              ),
            )
            return [sub, undefined] as const
          }),
        )

        return Stream.flatten(iterations)
      }),
    ),
)

type LoopFromBody<S, I, A, E, R> = (
  state: S,
  input: I,
) => Stream.Stream<Event<A, S>, E, R> | Effect.Effect<Stream.Stream<Event<A, S>, E, R>, E, R>

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
                const wrapped: LoopBody<S, A, E, R> = (s) => {
                  const raw = reifyBody(body(s, item))
                  return raw.pipe(
                    Stream.tap((event) =>
                      Match.value(event).pipe(
                        Match.tags({
                          Next: (e) => Ref.set(stateRef, e.state),
                          StopWith: (e) => Ref.set(stateRef, e.state),
                        }),
                        Match.orElse(() => Effect.void),
                      ),
                    ),
                  )
                }
                return loop(state, wrapped)
              }),
            ),
          ),
        )
      }),
    ),
)

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
            Match.tags({
              Next: (e) => SubscriptionRef.set(stateRef, e.state),
              StopWith: (e) => SubscriptionRef.set(stateRef, e.state),
            }),
            Match.orElse(() => Effect.void),
          ),
        ),
      )
    const wrapped: LoopBody<S, A, E, R> = (s) => {
      const r = body(s)
      return Effect.isEffect(r) ? Effect.map(r, tap) : tap(r)
    }
    return { stream: loop(initial, wrapped), state: stateRef }
  })
