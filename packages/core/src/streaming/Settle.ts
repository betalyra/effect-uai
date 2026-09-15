/**
 * Acting on a pause in a stream of arrivals.
 *
 * A chat user types three lines then stops; a transcriber emits token deltas
 * then goes quiet. Both want a resetting window: every arrival pushes the
 * deadline out. Effect's `groupedWithin` measures a fixed window from the first
 * element of a batch and `debounce` drops all but the last element, so neither
 * expresses this.
 *
 * `settleBurst` withholds elements until a burst ends; `onQuiet` holds nothing
 * back and only adds an event once things go still.
 */
import {
  Array as Arr,
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Function,
  Option,
  Pull,
  Queue,
  Ref,
  Result,
  Stream,
} from "effect"

/** Buffer between a source stream and the batcher. 64 matches the realtime adapters. */
const DEFAULT_CAPACITY = 64

/**
 * Block for the first item, then keep taking while the next one lands within
 * `settle` of the previous. The window resets on every arrival, so a burst
 * becomes one batch and a lone message followed by silence returns at once.
 *
 * A take that loses to the window is interrupted before it removes anything,
 * so late arrivals stay queued for the next drain. The queue is the caller's:
 * it owns the backpressure strategy.
 */
export const drainBurst = <A, E>(
  queue: Queue.Dequeue<A, E>,
  settle: Duration.Input,
): Effect.Effect<Arr.NonEmptyReadonlyArray<A>, E> => {
  const settled = (
    batch: Arr.NonEmptyReadonlyArray<A>,
  ): Effect.Effect<Arr.NonEmptyReadonlyArray<A>, E> =>
    Queue.take(queue).pipe(
      Effect.timeoutOption(settle),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(batch),
          onSome: (item) => settled(Arr.append(batch, item)),
        }),
      ),
      // A queue that ends mid-burst yields the batch in hand. Interrupts and
      // real failures still propagate.
      Effect.catchCause((cause) =>
        Pull.isDoneCause(cause) ? Effect.succeed(batch) : Effect.failCause(cause),
      ),
    )
  return Effect.flatMap(Queue.take(queue), (first) => settled([first]))
}

export type SettleBurstOptions = {
  /** Elements buffered ahead of the batcher. A full buffer suspends the source. */
  readonly capacity?: number
}

/**
 * `drainBurst` over a stream: one array per burst, nothing while a burst is
 * still growing.
 *
 * Detecting a pause means reading ahead of the consumer, so this buffers by
 * construction. The buffer is bounded, so a slow consumer suspends the source
 * instead of growing memory.
 */
export const settleBurst: {
  (
    settle: Duration.Input,
    options?: SettleBurstOptions,
  ): <A, E, R>(self: Stream.Stream<A, E, R>) => Stream.Stream<ReadonlyArray<A>, E, R>
  <A, E, R>(
    self: Stream.Stream<A, E, R>,
    settle: Duration.Input,
    options?: SettleBurstOptions,
  ): Stream.Stream<ReadonlyArray<A>, E, R>
} = Function.dual(
  (args) => Stream.isStream(args[0]),
  <A, E, R>(
    self: Stream.Stream<A, E, R>,
    settle: Duration.Input,
    options?: SettleBurstOptions,
  ): Stream.Stream<ReadonlyArray<A>, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // `Cause.Done` as the failure type is what makes `Queue.end` available;
        // `Queue.shutdown` would clear items still waiting to be batched.
        const queue = yield* Queue.bounded<A, E | Cause.Done>(options?.capacity ?? DEFAULT_CAPACITY)
        yield* Stream.runForEach(self, (a) => Queue.offer(queue, a)).pipe(
          // A failing source must reach the consumer. Ending the queue instead
          // would present the failure as a clean end of stream.
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Cause.hasFails(cause) ? Queue.failCause(queue, cause) : Queue.end(queue),
            onSuccess: () => Queue.end(queue),
          }),
          Effect.forkScoped,
        )
        return Stream.fromPull(
          Effect.succeed(Effect.map(drainBurst(queue, settle), (batch) => [batch] as const)),
        )
      }),
    ),
)

/**
 * Pass every element through the moment it arrives, and emit whatever `emit`
 * yields once nothing has arrived for `settle`. At most one emission per quiet
 * period: the next element re-arms it.
 *
 * Nothing is held back, so this suits live output that wants a boundary marker
 * rather than batching. Ends with the source.
 */
export const onQuiet: {
  <B>(
    settle: Duration.Input,
    emit: Effect.Effect<Option.Option<B>>,
  ): <A, E, R>(self: Stream.Stream<A, E, R>) => Stream.Stream<A | B, E, R>
  <A, E, R, B>(
    self: Stream.Stream<A, E, R>,
    settle: Duration.Input,
    emit: Effect.Effect<Option.Option<B>>,
  ): Stream.Stream<A | B, E, R>
} = Function.dual(
  3,
  <A, E, R, B>(
    self: Stream.Stream<A, E, R>,
    settle: Duration.Input,
    emit: Effect.Effect<Option.Option<B>>,
  ): Stream.Stream<A | B, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const settleMs = Duration.toMillis(settle)
        const lastAt = yield* Ref.make(0)
        // Opened by the first arrival after each emission. An idle stream never
        // wakes the metronome at all.
        const gate = yield* Ref.make(yield* Deferred.make<void>())

        const source = self.pipe(
          Stream.tap(() =>
            Effect.gen(function* () {
              // Stamp before opening: the metronome re-reads the stamp after it
              // swaps the gate, so an arrival that races the swap still counts.
              const now = yield* Clock.currentTimeMillis
              yield* Ref.set(lastAt, now)
              const open = yield* Ref.get(gate)
              yield* Deferred.succeed(open, undefined)
            }),
          ),
        )

        const quietFor = Effect.map(
          Effect.all([Clock.currentTimeMillis, Ref.get(lastAt)]),
          ([now, last]) => now - last,
        )

        // Waits for the gate, then sleeps out whatever is left of the window.
        // Never polls, whether the source is busy or idle.
        const tick = Effect.gen(function* () {
          yield* Effect.flatMap(Ref.get(gate), Deferred.await)
          const elapsed = yield* quietFor
          if (elapsed < settleMs) {
            yield* Effect.sleep(Duration.millis(settleMs - elapsed))
            return Option.none<B>()
          }
          const next = yield* Deferred.make<void>()
          yield* Ref.set(gate, next)
          // An arrival between the check and the swap opened the old gate, so
          // carry it over rather than sleeping through the burst it started.
          if ((yield* quietFor) < settleMs) {
            yield* Deferred.succeed(next, undefined)
            return Option.none<B>()
          }
          return yield* emit
        })

        const metronome = Stream.fromEffect(tick).pipe(
          Stream.forever,
          Stream.filterMap((o) => (Option.isSome(o) ? Result.succeed(o.value) : Result.failVoid)),
        )

        return source.pipe(Stream.merge(metronome, { haltStrategy: "left" }))
      }),
    ),
)
