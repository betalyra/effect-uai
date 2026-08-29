---
"@effect-uai/core": minor
"@effect-uai/jina": minor
---

New `Reranker` capability (additive). Give it a query and a candidate set, get
back scored positions, best first. It is a per-hop filter for agent loops:
anywhere a search, a retrieval, or a tool produces more candidates than the
model can afford to read.

- **`@effect-uai/core/Reranker`**: the generic `Reranker` tag and the
  `rerank(request)` helper. A request is `{ query, documents, model, topN? }`;
  a response is `{ results: [{ index, score }], usage }`, where `index` points
  back into the `documents` you passed. `results` is sorted descending and
  higher is better, but scores are not calibrated and are not comparable across
  calls, so cut by rank rather than by a fixed threshold.
- **`@effect-uai/jina/JinaReranker`**: the first provider, registering both the
  typed `JinaReranker` tag and the generic one. Models are `jina-reranker-v3.5`
  (default), `jina-reranker-v3`, and `jina-reranker-m0`. The typed request
  widens `documents` to `{ text }` / `{ image: ImageSource }` for m0's visual
  documents, using the same `ImageSource` helpers as multimodal embedding; the
  cross-provider request stays strings-only.

See [reranking](https://effect-uai.betalyra.com/reranking/).

See [Migrating to 0.13](https://effect-uai.betalyra.com/migrations/v0-13/).
