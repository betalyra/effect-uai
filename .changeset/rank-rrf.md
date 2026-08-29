---
"@effect-uai/core": minor
---

Add `Rank.rrf`, reciprocal rank fusion, at `@effect-uai/core/Rank`.

Merge several ranked lists over the same items into one ranking by position:
`score(v) = Σ weightᵢ / (k + rankᵢ(v))`, 1-based ranks, `k` defaulting to 60 and
`weights` to 1 per list. A list that omits an item contributes nothing to it.
The result is sorted descending, with ties in first-seen order.

Fusing by rank rather than by score is what makes hybrid retrieval work:
BM25 relevance and cosine similarity are on incomparable scales, so combining
them numerically needs a normalization nobody agrees on, while their orderings
combine directly.

```ts
import { rrf } from "@effect-uai/core/Rank"

// two retrievers over the same document ids
rrf([denseIds, lexicalIds], { weights: [1, 0.7] })
// => [{ value: id, score }, ...] best first
```
