/** Certainty measures over a probability vector. */
import { Array as A, Number as N, Option, Order, pipe } from "effect"

const descending = Order.flip(Order.Number)

/**
 * 1 minus normalized Shannon entropy: 1 when all mass sits on one outcome, 0
 * when spread evenly. Fewer than two outcomes yields 1.
 *
 * Conservative on two outcomes, where `[0.94, 0.06]` scores ~0.67, so a
 * threshold tuned on a long vector does not transfer. {@link margin} is the
 * more stable gate across vectors of different length.
 */
export const confidence = (probabilities: ReadonlyArray<number>): number =>
  probabilities.length < 2
    ? 1
    : 1 -
      pipe(
        probabilities,
        A.filter((p) => p > 0),
        A.map((p) => -p * Math.log(p)),
        N.sumAll,
      ) /
        Math.log(probabilities.length)

/**
 * Top mass minus runner-up mass, which unlike {@link confidence} separates a
 * close second from a flat spread. A single outcome yields its own
 * probability; empty yields 0.
 */
export const margin = (probabilities: ReadonlyArray<number>): number => {
  const top = pipe(probabilities, A.sort(descending), A.take(2))
  return pipe(
    A.get(top, 0),
    Option.map((first) =>
      pipe(
        A.get(top, 1),
        Option.getOrElse(() => 0),
        (second) => first - second,
      ),
    ),
    Option.getOrElse(() => 0),
  )
}
