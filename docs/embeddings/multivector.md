---
title: Multivector embedding
description: Late-interaction retrieval — one vector per token, scored with MaxSim.
---

A query like "store sourdough starter at room temperature" has four
distinct ideas in it. Single-vector cosine compresses all four into one
point and the right document wins or loses based on the average. Often
the document you want has only three of the four ideas at the top —
and the average loses to a document that mentions all four superficially.

Multivector embeddings keep the ideas separate. Each input becomes one
vector per token instead of one summary vector, and the score lets each
query token find its own best-matching document token. The fine-grained
matching that single-vector cosine smears out comes back.

**Scenario.** Embed a query and a corpus of longer documents with
`encoding: "multivector"`. Rank by `Vector.maxSim` instead of cosine.

## What MaxSim does

For each query vector, find the maximum dot product with any document
vector, then sum across query vectors:

```ts
import * as Vector from "@effect-uai/core/Vector"

const score = Vector.maxSim(queryEmbedding, docEmbedding)
```

Each query token "votes" for its best-matching document token. The
final score is the sum of those votes, so a document that has good
matches for *every* part of the query beats one that has a great match
for some parts and nothing for the rest.

Cost is `O(|q| × |d| × dim)` per pair. Fine at recipe volume; for
production-scale retrieval use a vector store with native multivector
indexing (Vespa, Qdrant, PLAID).

## One model, two encodings

Multivector lives on `jina-embeddings-v4` today. The same model also
produces dense single vectors — you choose per request:

```ts
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"

// Late-interaction: one vector per token
const mv = yield* embed({
  model: "jina-embeddings-v4",
  input: query,
  task: "query",
  encoding: "multivector",
})

// Dense baseline: one vector per input
const dense = yield* embed({
  model: "jina-embeddings-v4",
  input: query,
  task: "query",
})
```

Both go through the generic `EmbeddingModel` tag. The wire-level flag
(`return_multivector: true`) is set inside the Jina layer; you pick
the shape via `encoding`.

## Narrowing the result

`Embedding` is a tagged union, so you narrow before passing to
`Vector.maxSim`:

```ts
import * as Embedding from "@effect-uai/core/Embedding"

if (Embedding.isMultivector(result.embedding)) {
  // result.embedding.vectors is ReadonlyArray<Float32Array>
}
```

If the chosen model can't produce a multivector, the Jina layer fails
the request with a typed encoding-mismatch error rather than silently
returning a dense vector.

## What to expect from MaxSim scores

MaxSim scores are unbounded — sum of dot products, not normalized
to `[-1, 1]`. A score of `9.4` versus `7.6` says one document beats
another, but the absolute number depends on query length, vector
dimension, and whether vectors are normalized. Use scores comparatively
within one query, not as a transferable threshold.

For short, distinct-topic corpora the ranking often matches cosine
ranking on dense vectors of the same model — the multivector advantage
shows on longer documents with overlapping topics and specific terms.
The recipe runs both side-by-side so you can see when they diverge.

## Storage trade-off

Multivector is meaningfully bigger per document. A typical comparison:

- **Single-vector**: one `Float32Array` of ~1024–3072 dims per document.
- **Multivector**: ~50–500 vectors per document, each ~128 dim.

Net: ~5–10× more storage. The win is precision; the cost is index
size. Many production setups use dense for the first pass and
multivector (or a reranker) only on the candidate set.

## Run it

```sh
JINA_API_KEY=... pnpm tsx recipes/multivector-embedding/index.ts
```

The full source is at
[`recipes/multivector-embedding/index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/multivector-embedding/index.ts).
The recipe ranks five documents (sourdough, marathon, TypeScript,
bread machines, hydration) by both MaxSim and cosine so you can see
the patterns side by side.

## See also

- [Embedding model](/embeddings/) — the concept page, including the
  full `Embedding` union and `Vector.*` primitives.
- [Multimodal embedding](/embeddings/multimodal/) — when you want
  cross-modal retrieval, not deeper single-modality precision.
- [Reranking](/reranking/) (coming soon) — different precision tool,
  same problem class.
