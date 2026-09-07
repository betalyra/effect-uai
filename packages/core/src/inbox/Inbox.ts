/**
 * Input a long-lived agent reads between turns. A chat user rarely sends one
 * tidy message: they type three lines in a row, then go quiet. The loop wants
 * that as one batch, taken at a clean turn boundary.
 */
import { Array as Arr, type Duration, Effect, Option, Queue } from "effect"

/**
 * Block for the first item, then keep taking while the next one lands within
 * `settle` of the previous. The window resets on every arrival, so a burst
 * becomes one batch and a lone message followed by silence returns at once.
 *
 * A take that loses to the window is interrupted before it removes anything,
 * so late arrivals stay queued for the next drain.
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
    )
  return Effect.flatMap(Queue.take(queue), (first) => settled([first]))
}
