/**
 * Toy primitive — a `Stream.paginate` that lets each iteration emit a *stream*
 * of values (not just an array) and terminate with a tagged `Decision` event
 * carrying the next state, or stop entirely.
 *
 * Why this exists: real-time forwarding (e.g. LLM token deltas) requires the
 * outer stream to flow through values as they arrive, while the loop still
 * threads state and short-circuits between iterations. `Stream.paginate`
 * gives state but not live sub-streams; `Stream.flatMap` gives live
 * sub-streams but no state threading. This combines both.
 *
 * Run: `pnpm tsx experiments/streamLoop.ts`
 */
import { Effect, Option, Ref, Stream } from "effect"

// ---------------------------------------------------------------------------
// Decision — the terminal control event each iteration's body must emit.
// ---------------------------------------------------------------------------

/**
 * Symbol-keyed brand so user values that happen to share `_tag: "next"` /
 * `_tag: "stop"` shape don't collide with the loop's control protocol.
 */
const DecisionTag = Symbol.for("@betalyra/effect-uai/streamLoop/Decision")

export type Decision<S> =
  | { readonly [DecisionTag]: true; readonly _tag: "next"; readonly state: S }
  | { readonly [DecisionTag]: true; readonly _tag: "stop" }

export const next = <S>(state: S): Decision<S> => ({
  [DecisionTag]: true,
  _tag: "next",
  state,
})

export const stop: Decision<never> = {
  [DecisionTag]: true,
  _tag: "stop",
}

const isDecision = (v: unknown): v is Decision<unknown> =>
  typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[DecisionTag] === true

// ---------------------------------------------------------------------------
// loop — the primitive
// ---------------------------------------------------------------------------

/**
 * Drive a stream made of state-threaded sub-streams. Each iteration's body
 * is a `Stream<A | Decision<S>>` that may emit any number of A values and
 * then terminate with `next(nextState)` to recurse or `stop` to end.
 *
 * If the body's stream ends *without* emitting a Decision, the loop ends
 * silently — same behaviour as forgetting `return` in `Stream.paginate`.
 */
export const loop = <S, A, E, R>(
  initial: S,
  body: (state: S) => Stream.Stream<A | Decision<S>, E, R>,
): Stream.Stream<A, E, R> => {
  const go = (state: S): Stream.Stream<A, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const decisionRef = yield* Ref.make<Option.Option<Decision<S>>>(Option.none())

        const passthrough: Stream.Stream<A, E, R> = body(state).pipe(
          Stream.tap((elem) =>
            isDecision(elem)
              ? Ref.set(decisionRef, Option.some(elem as Decision<S>))
              : Effect.void,
          ),
          Stream.flatMap((elem) =>
            isDecision(elem) ? Stream.empty : Stream.make(elem as A),
          ),
        )

        const continuation: Stream.Stream<A, E, R> = Stream.unwrap(
          Ref.get(decisionRef).pipe(
            Effect.map(
              (decision): Stream.Stream<A, E, R> =>
                Option.match(decision, {
                  onNone: () => Stream.empty,
                  onSome: (d) => (d._tag === "next" ? go(d.state) : Stream.empty),
                }),
            ),
          ),
        )

        return Stream.concat(passthrough, continuation)
      }),
    )

  return go(initial)
}

// ---------------------------------------------------------------------------
// Toy demo: count from 0 to 6, emitting halves between integers.
// ---------------------------------------------------------------------------

const demo = loop(0, (n) =>
  n >= 6
    ? Stream.fromIterable([n, stop])
    : Stream.fromIterable([n, n + 0.5, next(n + 1)]),
)

const program = Effect.gen(function* () {
  yield* Stream.runForEach(demo, (v) => Effect.sync(() => console.log(v)))
})

// Only run when executed directly (not when imported by the test).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("streamLoop.ts")

if (isMain) {
  Effect.runPromise(program).catch((err) => {
    console.error("demo failed:", err)
    process.exit(1)
  })
}
