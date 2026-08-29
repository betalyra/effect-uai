---
title: Reranking
description: Score a candidate set against a query and keep the few that matter. A filtering primitive for agent loops, one generic service tag, swappable providers.
icon: PiStack
---

Your agent just searched and got back fifty candidates. You can afford to put
five in the prompt. Which five?

`Reranker` answers that. Give it the query and the candidates, get back scored
positions, best first. It reads the query and each candidate together, which is
how it catches relevance that a distance between two separately-built vectors
misses.

Reach for it anywhere your agent finds more than it can afford to read: search
results, retrieved chunks, tool output, a list of files. It is a filter you run
per hop, not a stage bolted to the end of a pipeline.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/jina effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as jinaRerankerLayer } from "@effect-uai/jina/JinaReranker"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("JINA_API_KEY")
    return jinaRerankerLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

One layer, two tags: `JinaReranker` for Jina's own options, `Reranker` for
provider-portable code.

## Rerank

```ts
import { rerank } from "@effect-uai/core/Reranker"

const program = Effect.gen(function* () {
  const { results } = yield* rerank({
    model: "jina-reranker-v3.5",
    query: "how do I cancel my subscription",
    documents: candidates,
    topN: 5,
  })

  return results.map((r) => candidates[r.index])
})
```

`results` carries positions, not text. Each `index` points back into the
`documents` you passed, so whatever your candidates were attached to (an id, a
URL, a chunk with metadata) is still there. No matching strings back up
afterwards.

```ts
interface CommonRerankRequest {
  readonly query: string
  readonly documents: ReadonlyArray<string>
  readonly model: string
  readonly topN?: number
}

interface RerankResponse {
  readonly results: ReadonlyArray<{ index: number; score: number }>
  readonly usage: { totalTokens?: number }
}
```

`topN` trims the response to the best N. Leave it off to score everything and
apply your own cutoff.

## About the scores

Sorted descending, higher is better. That is the whole contract. Scores are not
calibrated probabilities and not comparable between calls: a listwise model
scores each candidate relative to the others it was shown, so the same document
scores differently in a different candidate set.

Rank-based cutoffs (`topN: 5`, or "everything above the median") therefore
travel. A fixed threshold like `score > 0.8` does not, and will drift between
models and between queries.

## Ranking images

`jina-reranker-m0` ranks visual documents: screenshots, scanned pages, charts,
slides. Yield the typed `JinaReranker` tag to pass them, with the same
`ImageSource` helpers multimodal embedding uses.

```ts
import { imageUrl } from "@effect-uai/core/Image"
import { JinaReranker } from "@effect-uai/jina/JinaReranker"

const program = Effect.gen(function* () {
  const jina = yield* JinaReranker
  return yield* jina.rerank({
    model: "jina-reranker-m0",
    query: "quarterly revenue by segment",
    documents: [
      { text: "Revenue grew 12% year over year..." },
      { image: imageUrl("https://example.com/slide-14.png") },
    ],
  })
})
```

The query stays text either way. Mixed documents are a Jina option reached
through the typed tag, which is why the generic request stays strings-only.

Model ids are just strings, so a newly released reranker works without an SDK
update. Check your provider's model list for what is current.

## What reranking is not

- **Not retrieval.** A reranker scores candidates you already have. Finding
  them is [embeddings](/embeddings/), [search](/search/), or your own index,
  and preparing them is [retrieval](/retrieval/).
- **Not an embedding model.** There is no vector to store. Every call scores
  one query against one candidate set, so nothing caches into an index the way
  embeddings do.
- **Not a threshold filter.** See the note on scores above.

## See also

- [Retrieve and rerank](/recipes/retrieve-and-rerank/): the two stages end to
  end, with the before and after printed side by side.
- [Agentic search](/recipes/agentic-search/): reranking on top of fused keyword and
  vector retrieval, as a tool an agent calls.
- [Embeddings](/embeddings/): produce the candidates, then rerank them.
- [Retrieval](/retrieval/): chunk the documents and fuse the rankings that
  feed a reranker.
