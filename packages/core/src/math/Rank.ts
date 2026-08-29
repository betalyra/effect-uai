/**
 * Rank fusion: merge several ranked lists of the same items into one
 * ranking by position, so retrievers on incomparable score scales
 * (BM25, cosine) can be combined without normalizing them.
 */
import { Array as Arr, Order, pipe } from "effect"

export type Fused<A> = {
  readonly value: A
  readonly score: number
}

const byScore = Order.mapInput(Order.flip(Order.Number), (f: { readonly score: number }) => f.score)

/**
 * Reciprocal rank fusion: `score(v) = Σ weightᵢ / (k + rankᵢ(v))` over
 * 1-based ranks, where a list omitting `v` contributes nothing. `k`
 * defaults to 60, `weights` to 1 per ranking.
 *
 * Items are keyed by `Map` semantics, so fuse ids rather than fresh
 * objects. Sorted descending; ties keep first-seen order.
 */
export const rrf = <A>(
  rankings: ReadonlyArray<ReadonlyArray<A>>,
  options?: { readonly k?: number; readonly weights?: ReadonlyArray<number> },
): Array<Fused<A>> => {
  const k = options?.k ?? 60
  return pipe(
    Arr.reduce(rankings, new Map<A, number>(), (scores, ranking, i) =>
      Arr.reduce(ranking, scores, (acc, value, rank) =>
        acc.set(value, (acc.get(value) ?? 0) + (options?.weights?.[i] ?? 1) / (k + rank + 1)),
      ),
    ),
    Arr.fromIterable,
    Arr.map(([value, score]): Fused<A> => ({ value, score })),
    Arr.sort(byScore),
  )
}
