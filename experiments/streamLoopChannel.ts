/**
 * Spike: linear-time `loop` built on `Channel.callbackArray`. Same external
 * API as the recursive Stream version.
 *
 * The previous Channel-based attempt (recursive `Channel.concatWith`) was
 * still O(N²) because each iteration constructed a new wrapping combinator
 * value. To get linear time, the iteration has to happen *inside a single
 * combinator's evaluation*, not by repeated combinator application.
 *
 * `Channel.callbackArray` is the lowest-level primitive that does this:
 * give it an Effect that pushes values into a Queue, and it gives back a
 * Channel that pulls from the Queue. The recursion across iterations is
 * replaced by a `while` loop *inside* one Effect — no nested combinators.
 *
 * Run: `pnpm tsx experiments/streamLoopChannel.ts`
 */
import { Channel, Effect, Option, Queue, Ref, Stream } from "effect";

const DecisionTag = Symbol.for(
  "@betalyra/effect-uai/streamLoopChannel/Decision",
);

export type Decision<S> =
  | { readonly [DecisionTag]: true; readonly _tag: "next"; readonly state: S }
  | { readonly [DecisionTag]: true; readonly _tag: "stop" };

export const next = <S>(state: S): Decision<S> => ({
  [DecisionTag]: true,
  _tag: "next",
  state,
});

export const stop: Decision<never> = {
  [DecisionTag]: true,
  _tag: "stop",
};

const isDecision = (v: unknown): v is Decision<unknown> =>
  typeof v === "object" &&
  v !== null &&
  (v as Record<symbol, unknown>)[DecisionTag] === true;

export const loop = <S, A, E, R>(
  initial: S,
  body: (state: S) => Stream.Stream<A | Decision<S>, E, R>,
): Stream.Stream<A, E, R> =>
  Stream.fromChannel(
    Channel.callbackArray<A, E, R>(
      (queue) =>
        Effect.gen(function* () {
          // Single while-loop drives all iterations. `let state` is fiber-
          // local — invisible from the public API. No combinators built per
          // iteration → O(1) per iter → O(N) total.
          let state: S = initial;
          while (true) {
            const decisionRef = yield* Ref.make<Option.Option<Decision<S>>>(
              Option.none(),
            );
            // `takeUntil(isDecision)` stops pulling from the body as soon as
            // the Decision is seen; anything after it is never pulled.
            yield* body(state).pipe(
              Stream.takeUntil(isDecision),
              Stream.runForEach((elem) =>
                isDecision(elem)
                  ? Ref.set(decisionRef, Option.some(elem))
                  : Effect.asVoid(Queue.offer(queue, elem)),
              ),
            );
            const decision = yield* Ref.get(decisionRef);
            if (Option.isNone(decision) || decision.value._tag === "stop") break;
            state = decision.value.state;
          }
          // Signal end-of-stream so Stream.fromChannel can terminate cleanly.
          yield* Queue.end(queue);
        }).pipe(
          // If the body's stream fails, route the error into the Queue so the
          // outer Stream sees it instead of hanging on a never-closed queue.
          // (Defects and interrupts are deliberately left to propagate.)
          Effect.catchIf(
            (_err): _err is E => true,
            (err) => Queue.fail(queue, err),
          ),
        ),
      // Bounded queue + suspend strategy → backpressure. When the queue is
      // full, Queue.offer suspends, which suspends runForEach, which stops
      // pulling from body(state), which back-pressures the upstream Stream
      // (e.g. HTTP read pauses). Without this, Queue.make defaults to
      // capacity = Infinity and the producer can run away.
      { bufferSize: 16, strategy: "suspend" },
    ),
  );

// ---------------------------------------------------------------------------
// Smoke test — run with `pnpm tsx experiments/streamLoopChannel.ts` to
// verify correctness in isolation before benchmarking.
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("streamLoopChannel.ts");

if (isMain) {
  const stream = loop(0, (n: number) =>
    n >= 5
      ? Stream.fromIterable([n, stop])
      : Stream.fromIterable([n, n + 0.5, next(n + 1)]),
  );
  Effect.runPromise(Stream.runCollect(stream))
    .then((vals) => {
      console.log("collected:", vals);
    })
    .catch((err) => {
      console.error("smoke failed:", err);
      process.exit(1);
    });
}
