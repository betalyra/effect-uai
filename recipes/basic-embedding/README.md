---
title: Basic embedding
description: Embed a query and a corpus, rank by cosine — the RAG retrieval primitive in one file.
source: recipes/basic-embedding
---

This is the smallest end-to-end shape: one query, a list of documents,
similarity ranking. No vector DB, no chunker, no reranker. The same
shape grows into RAG retrieval, semantic search, and clustering once
you swap the local array for a real index.

**Scenario.** Embed the question "How do I make sourdough bread at
home?" and five short documents (some on-topic, some not). Rank the
documents by cosine similarity to the query.

## Embed The Query And The Corpus

```ts
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"

const [queryResult, docsResult] =
  yield *
  Effect.all(
    [
      embed({ model, input: query, task: "query" }),
      embedMany({ model, inputs: documents, task: "document" }),
    ],
    { concurrency: "unbounded" },
  )
```

Two helpers:

- **`embed`** — one input, one HTTP call.
- **`embedMany`** — N inputs, one HTTP call. Cheaper and faster than
  N parallel `embed`s, and the only way to get the same `task`
  applied uniformly across the batch.

Both yield the generic `EmbeddingModel` tag, so the program shape is
provider-agnostic. The layer at the bottom decides which provider
answers.

## Rank By Cosine

```ts
import * as Vector from "@effect-uai/core/Vector"

const ranked = documents
  .map((doc, i) => ({
    doc,
    score: Vector.cosine(qVec, docVecs[i]),
  }))
  .sort((a, b) => b.score - a.score)
```

`Vector.cosine` is allocation-free — fine inside `.map` over thousands
of vectors. For vector-DB scale, reach for a dedicated index or a
vector store; this lives at the recipe-volume tier.

## Narrowing The Embedding

The provider returns an `Embedding` tagged union — one arm per wire
shape (`float32`, `int8`, `binary`, `sparse`, `multivector`). For the
default float32 path you narrow with a predicate:

```ts
import * as Embedding from "@effect-uai/core/Embedding"

const asFloat32 = (e: Embedding.Embedding) =>
  Embedding.isFloat32(e) ? Effect.succeed(e.vector) : Effect.fail(/* InvalidRequest */)
```

The tag reflects the wire form the provider returned, not what you
asked for. This matters when you mix encodings — see the
[multivector recipe](/embeddings/multivector/) for the late-interaction
shape.

## Task Hint

The `task` field is the cross-provider retrieval-quality knob:

- `"query"` — for the query side of asymmetric retrieval.
- `"document"` — for the corpus side.

Provider behaviour varies. Jina v4 needs it for retrieval-quality
results. `gemini-embedding-001` honours it via `taskType`.
`gemini-embedding-2` ignores it (uses prompt prefix instructions
instead). OpenAI ignores it entirely. Pass it everywhere — harmless
when ignored, important when honoured.

## Swap Providers At The Layer

Three providers, same program:

```sh
GOOGLE_API_KEY=...   pnpm tsx recipes/basic-embedding/index.ts --provider=gemini
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-embedding/index.ts --provider=openai
JINA_API_KEY=...     pnpm tsx recipes/basic-embedding/index.ts --provider=jina
```

The recipe parses `--provider` and selects:

| Provider | Model                    |
| -------- | ------------------------ |
| `gemini` | `gemini-embedding-2`     |
| `openai` | `text-embedding-3-small` |
| `jina`   | `jina-embeddings-v4`     |

The model identifier is the only thing that changes between providers
in the program body — the rest is layer-level wiring.

## What This Generalizes To

Same shape, larger surface:

- **Real RAG**: replace the local `documents` array with a vector
  store (Pinecone, Qdrant, pgvector). Embed once on ingestion, embed
  the query at search time.
- **Semantic search**: same code, no reranker — a baseline you can
  measure improvements against.
- **Cross-modal retrieval**: swap `string` inputs for
  `{ image: ImageSource }` — see
  [multimodal embedding](/embeddings/multimodal/).
- **Late-interaction**: request `encoding: "multivector"` via the typed
  `JinaEmbedding` service and rank with `Vector.maxSim` instead — see
  [multivector embedding](/embeddings/multivector/).

## See also

- [Embedding model](/embeddings/) — the concept: service tag, encoding
  union, multimodal input, vector math.
- The full source is at
  [`recipes/basic-embedding/index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-embedding/index.ts).
