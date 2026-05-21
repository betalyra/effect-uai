/**
 * Spike v2 — keeps the outer `unfold + flatten` (recursion-scheme-shaped
 * iteration) but collapses the per-element `takeUntil + tap + filterMap`
 * pipeline into ONE chunk-aware `Stream.transformPull` that:
 *
 *   - scans each chunk for the first non-`Value` (the decision)
 *   - emits all preceding `Value`s in one pass (no Effect-per-element)
 *   - applies the decision's side effect (state/done refs) once per
 *     iteration
 *   - signals `Cause.done()` to end the substream
 *
 * Outer structure unchanged from LoopSpike.ts; only the per-iteration
 * substream is now chunk-level.
 *
 * Status: passes all 33 tests of Loop.test.ts. ~2.7x slower than Loop.ts at
 * the 100k-iteration stress test (LoopSpike.ts was 4.1x). The remaining
 * overhead is per-iteration outer machinery (unfold emits substream →
 * flatten opens it → it drains one chunk → flatten closes it → repeat),
 * which only Loop.ts's inlined-into-one-fromPull design avoids. Kept on
 * this branch as a reference impl, not for merge.
 */
import {
  Array as Arr,
  Cause,
  Effect,
  Function,
  Match,
  Pull,
  Ref,
  Stream,
  SubscriptionRef,
} from "effect"
import { type Event, stopEvent } from "./Loop.js"

export {
  type Event,
  next,
  nextAfter,
  nextAfterFold,
  onTurnComplete,
  stop,
  stopAfter,
  stopEvent,
  stopWith,
  stopWithAfter,
  value,
} from "./Loop.js"

type LoopBody<S, A, E, R> = (
  state: S,
) => Stream.Stream<Event<A, S>, E, R> | Effect.Effect<Stream.Stream<Event<A, S>, E, R>, E, R>

const reifyBody = <S, A, E, R>(
  result: Stream.Stream<Event<A, S>, E, R> | Effect.Effect<Stream.Stream<Event<A, S>, E, R>, E, R>,
): Stream.Stream<Event<A, S>, E, R> => (Effect.isEffect(result) ? Stream.unwrap(result) : result)

/**
 * Per-iteration substream: emits values, applies the terminal decision's
 * side effect once, then signals done. Single chunk-aware pass.
 */
const drainBody = <S, A, E, R>(
  raw: Stream.Stream<Event<A, S>, E, R>,
  stateRef: Ref.Ref<S>,
  doneRef: Ref.Ref<boolean>,
): Stream.Stream<A, E, R> =>
  Stream.transformPull(
    Stream.concat(raw, Stream.succeed(stopEvent as Event<A, S>)),
    (pull, _scope) =>
      Effect.sync(() => {
        let finished = false
        const pump: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E, void, R> = Effect.suspend(() => {
          if (finished) return Cause.done()
          return Effect.flatMap(pull, (chunk) => {
            const decisionIdx = chunk.findIndex((e) => e._tag !== "Value")
            if (decisionIdx === -1) {
              // Pure-Value chunk — unwrap and emit.
              const values = chunk.map((e) => (e as { _tag: "Value"; value: A }).value)
              return Effect.succeed(values as unknown as Arr.NonEmptyReadonlyArray<A>)
            }
            finished = true
            const decision = chunk[decisionIdx]
            const apply = Match.value(decision).pipe(
              Match.tags({
                Next: (e) => Ref.set(stateRef, e.state),
                Stop: () => Ref.set(doneRef, true),
                StopWith: (e) =>
                  Effect.andThen(Ref.set(stateRef, e.state), Ref.set(doneRef, true)),
              }),
              Match.orElse(() => Effect.void),
            )
            const values = chunk
              .slice(0, decisionIdx)
              .map((e) => (e as { _tag: "Value"; value: A }).value)
            if (Arr.isReadonlyArrayNonEmpty(values)) {
              return Effect.as(apply, values)
            }
            return Effect.flatMap(apply, () => Cause.done<void>())
          })
        })
        return pump
      }),
  )

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
            return [drainBody(reifyBody(body(state)), stateRef, doneRef), undefined] as const
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
