/**
 * Recipe-local stream primitives:
 *
 * - `settleBurst`: resetting-window debounce. Each new arrival resets the
 *   timer; when the timer expires with no more arrivals, the buffered
 *   batch is emitted. Differs from `Stream.groupedWithin` (fixed window).
 *
 * v4 footgun discovered while building these: `Queue.shutdown` CLEARS
 * queued items and interrupts pending takes — wrong for clean producer
 * teardown. Use `Queue.end` (with a `Cause.Done` failure type) instead;
 * pending items drain first, then `take` fails with `Done`, which `Stream`
 * treats as a clean end-of-stream.
 */
import { Cause, type Duration, Effect, Function, Queue, Stream } from "effect"

// ---------------------------------------------------------------------------
// settleBurst — resetting-window debounce as a Stream operator.
//
// Each new arrival RESETS the timer. When `settle` elapses without new
// input, the buffered batch is emitted. Compare `Stream.groupedWithin`,
// which uses a fixed window from the first item in a batch.
//
// Implementation: fork a producer that drains the input into a queue with
// `Cause.Done` as the failure channel (so `Queue.end` is available).
// Drain bursts inline by racing `Queue.take` against `Effect.sleep(settle)`.
// ---------------------------------------------------------------------------

type NonEmpty<A> = readonly [A, ...Array<A>]

const drainOne = <A>(
  queue: Queue.Queue<A, Cause.Done>,
  settle: Duration.Input,
): Effect.Effect<NonEmpty<ReadonlyArray<A>>, Cause.Done> =>
  Effect.gen(function* () {
    // Block on the first item — yields `Done` if the queue already ended.
    const first = yield* Queue.take(queue)
    const batch: Array<A> = [first]
    while (true) {
      const next = yield* Effect.race(
        Queue.take(queue).pipe(Effect.map((a) => ({ kind: "item" as const, value: a }))),
        Effect.sleep(settle).pipe(Effect.as({ kind: "settle" as const })),
      ).pipe(
        // If the queue ends mid-burst (Done failure), finish the current
        // batch instead of failing.
        Effect.catchCause((cause) =>
          Cause.hasFails(cause)
            ? Effect.failCause(cause)
            : Effect.succeed({ kind: "end" as const }),
        ),
      )
      if (next.kind === "settle" || next.kind === "end") {
        // Wrap the batch as a `Pull`-friendly non-empty array of arrays.
        return [batch] as const
      }
      batch.push(next.value)
    }
  })

export const settleBurst: {
  (
    settle: Duration.Input,
  ): <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<ReadonlyArray<A>, E, R>
  <A, E, R>(
    stream: Stream.Stream<A, E, R>,
    settle: Duration.Input,
  ): Stream.Stream<ReadonlyArray<A>, E, R>
} = Function.dual(
  2,
  <A, E, R>(
    stream: Stream.Stream<A, E, R>,
    settle: Duration.Input,
  ): Stream.Stream<ReadonlyArray<A>, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Queue with `Cause.Done` failure type so we can call `Queue.end`,
        // which preserves queued items (unlike `Queue.shutdown` which clears them).
        const queue = yield* Queue.unbounded<A, Cause.Done>()
        yield* Stream.runForEach(stream, (a) => Queue.offer(queue, a))
          .pipe(Effect.ensuring(Queue.end(queue)), Effect.forkScoped)
        return Stream.fromPull(Effect.succeed(drainOne(queue, settle))).pipe(
          Stream.map((batch) => batch as ReadonlyArray<A>),
        )
      }),
    ),
)

