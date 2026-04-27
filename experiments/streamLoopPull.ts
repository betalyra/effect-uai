/**
 * Spike: pull-based `loop` for state-threaded sub-streams.
 *
 * Unlike `streamLoopChannel`, this implementation does not fork a producer
 * fiber or buffer through a Queue. The next body stream is only pulled when
 * downstream pulls the outer stream, so cancellation, failures, scoped
 * resources, and backpressure stay aligned with normal Stream semantics.
 *
 * Convention: emit `Decision` as the terminal control value for a body stream.
 * If a body emits additional values after a `Decision` in the same chunk, those
 * values are discarded, but side effects that produced that chunk may already
 * have run. Prefer `Stream.concat(deltas, Stream.fromIterable([next(state)]))`.
 *
 * Run: `pnpm tsx experiments/streamLoopPull.ts`
 */
import { Cause, Channel, Effect, Exit, Scope, Stream } from "effect"

const DecisionTag = Symbol("@betalyra/effect-uai/streamLoopPull/Decision")

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

const isNonEmpty = <A>(array: ReadonlyArray<A>): array is readonly [A, ...Array<A>] =>
  array.length > 0

interface CurrentBody<S, A, E, R> {
  readonly scope: Scope.Closeable
  readonly pull: Effect.Effect<ReadonlyArray<A | Decision<S>>, E | Cause.Done<void>, R>
}

const closeBody = <S, A, E, R>(
  current: CurrentBody<S, A, E, R>,
  exit: Exit.Exit<unknown, unknown>,
) => Scope.close(current.scope, exit)

export const loop = <S, A, E, R>(
  initial: S,
  body: (state: S) => Stream.Stream<A | Decision<S>, E, R>,
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
              const stream = body(state)
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
                    Effect.as(undefined as ReadonlyArray<A | Decision<S>> | undefined),
                  ),
              ),
              Effect.onError((cause) => closeActive(active, Exit.failCause(cause))),
            )

            if (chunk === undefined) {
              done = true
              return yield* Cause.done()
            }

            const decisionIndex = chunk.findIndex(isDecision)
            if (decisionIndex === -1) return chunk as readonly [A, ...Array<A>]

            const decision = chunk[decisionIndex] as Decision<S>
            const out = chunk.slice(0, decisionIndex) as Array<A>

            yield* closeActive(active, Exit.void)

            if (decision._tag === "stop") {
              done = true
            } else {
              state = decision.state
            }

            if (isNonEmpty(out)) return out
          }
        })

        return pull
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Smoke test — run with `pnpm tsx experiments/streamLoopPull.ts`.
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("streamLoopPull.ts")

if (isMain) {
  const stream = loop(0, (n: number) =>
    n >= 5
      ? Stream.fromIterable([n, stop])
      : Stream.fromIterable([n, n + 0.5, next(n + 1)]),
  )
  Effect.runPromise(Stream.runCollect(stream))
    .then((vals) => {
      console.log("collected:", vals)
    })
    .catch((err) => {
      console.error("smoke failed:", err)
      process.exit(1)
    })
}
