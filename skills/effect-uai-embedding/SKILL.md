---
name: effect-uai-embedding
description: Use when the user wants to embed text or images with effect-uai — semantic search, RAG retrieval primitive, cross-modal cosine ranking, or late-interaction (multivector) scoring. Covers the EmbeddingModel service, the Embedding tagged union (float32 / int8 / binary / sparse / multivector), provider wiring (OpenAI text-only, Gemini multimodal, Jina sparse / multivector / binary), and Vector math primitives (cosine, sparseCosine, maxSim).
license: MIT
---

# effect-uai embedding

Turn text and images into vectors. `EmbeddingModel` is the parallel of
`LanguageModel` — one generic service tag, swap providers at the layer.

Reach for this when the user says any of:

- "I want semantic search / RAG retrieval / a vector index"
- "Embed this text / these documents / this image"
- "Rank these candidates by similarity to a query"
- "Cross-modal retrieval — image query against a text + image corpus"
- "Late-interaction / ColBERT / multivector retrieval"

`effect-uai` produces vectors. Storage and indexing are userland (or a
vector DB).

## Install

```sh
pnpm add @effect-uai/core effect
# pick at least one embedding provider:
pnpm add @effect-uai/responses   # OpenAI text-only
pnpm add @effect-uai/google      # Gemini multimodal + task enum
pnpm add @effect-uai/jina        # Jina sparse / multivector / binary
```

## Provider wiring

Identical pattern across providers — only the import and env var change:

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as openaiEmbeddingLayer } from "@effect-uai/responses/OpenAIEmbedding"
// import { layer as geminiEmbeddingLayer } from "@effect-uai/google/GeminiEmbedding"
// import { layer as jinaEmbeddingLayer } from "@effect-uai/jina/JinaEmbedding"

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return openaiEmbeddingLayer({ apiKey })
  }),
)

const runtime = apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer))
```

Each `layer` registers two tags: the provider-typed one
(`OpenAIEmbedding` / `GeminiEmbedding` / `JinaEmbedding`) for extended
options, and the generic `EmbeddingModel` for portable code.

## The Embedding union

`Embedding` is a tagged union — narrow with predicates before doing
math:

| Tag | Shape | Score with |
|---|---|---|
| `float32` | `Float32Array` | `Vector.cosine` |
| `int8` | `Int8Array` | quantize-aware code |
| `binary` | `Uint8Array` (bit-packed) | hamming + reranker |
| `sparse` | `Record<string, number>` | `Vector.sparseCosine` |
| `multivector` | `ReadonlyArray<Float32Array>` | `Vector.maxSim` |

```ts
import * as Embedding from "@effect-uai/core/Embedding"
if (Embedding.isFloat32(result.embedding)) {
  // result.embedding.vector is Float32Array
}
```

The tag reflects the **wire form returned**, not what was requested.
Layers reject unsupported `encoding` values up front.

## Pattern 1 — Cosine ranking

The whole RAG retrieval primitive in one file:

```ts
import { Effect } from "effect"
import * as Embedding from "@effect-uai/core/Embedding"
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"
import * as Vector from "@effect-uai/core/Vector"
import * as AiError from "@effect-uai/core/AiError"

const asFloat32 = (e: Embedding.Embedding) =>
  Embedding.isFloat32(e)
    ? Effect.succeed(e.vector)
    : Effect.fail(
        new AiError.InvalidRequest({
          provider: "embedding",
          param: "encoding",
          raw: `expected float32, got "${e._tag}"`,
        }),
      )

export const program = Effect.gen(function* () {
  const model = "text-embedding-3-small"
  const [q, docs] = yield* Effect.all(
    [
      embed({ model, input: query, task: "query" }),
      embedMany({ model, inputs: documents, task: "document" }),
    ],
    { concurrency: "unbounded" },
  )
  const qVec = yield* asFloat32(q.embedding)
  const docVecs = yield* Effect.forEach(docs.embeddings, asFloat32)
  return documents
    .map((doc, i) => ({ doc, score: Vector.cosine(qVec, docVecs[i]!) }))
    .sort((a, b) => b.score - a.score)
})
```

`task: "query" | "document"` is the cross-provider hint. Pass it
everywhere — Jina v4 needs it, OpenAI ignores it.

## Pattern 2 — Multimodal (cross-modal retrieval)

Embed images and text in one batch. Requires `gemini-embedding-2`,
`jina-embeddings-v4`, or `jina-clip-v2`.

```ts
import * as Image from "@effect-uai/core/Image"
import { embedMany } from "@effect-uai/core/EmbeddingModel"
import type { EmbedInput } from "@effect-uai/core/Embedding"

const inputs: ReadonlyArray<EmbedInput> = [
  { image: Image.imageBytes(jpegBytes, "image/jpeg") },
  { text: "A photo of artisan sourdough bread" },
]

const result = yield* embedMany({ model: "gemini-embedding-2", inputs })
// then cosine-rank as in pattern 1
```

`ImageSource` is `url` / `base64` / `bytes`. Gemini rejects `url`
(no auto-upload), Jina accepts all three.

## Pattern 3 — Multivector (late-interaction)

One vector per token. Score with `Vector.maxSim`. Currently
`jina-embeddings-v4` only.

```ts
import { JinaEmbedding } from "@effect-uai/jina/JinaEmbedding"

const program = Effect.gen(function* () {
  const jina = yield* JinaEmbedding
  const [q, docs] = yield* Effect.all(
    [
      jina.embed({
        model: "jina-embeddings-v4",
        input: query,
        task: "retrieval.query",
        encoding: "multivector",
      }),
      jina.embedMany({
        model: "jina-embeddings-v4",
        inputs: documents,
        task: "retrieval.passage",
        encoding: "multivector",
      }),
    ],
    { concurrency: "unbounded" },
  )
  // narrow with Embedding.isMultivector, then Vector.maxSim(q, doc)
})
```

MaxSim scores are unbounded sums of dot products — comparable within
one query, not transferable thresholds.

## Anti-patterns

- **Don't assume `_tag === "float32"`.** When the user requests
  `binary`, `sparse`, or `multivector`, narrow with `Embedding.is*`
  and fail typed if the shape is unexpected.
- **Don't `await` per input when `embedMany` works.** N parallel
  `embed`s cost N HTTP round-trips and lose batch-uniform `task`.
- **Don't store float32 vectors in JSON.** Lossy on round-trip.
  Persist as `Buffer.from(vec.buffer)` or `new Uint8Array(vec.buffer)`.
- **Don't compare cosines across different models.** A 0.65 from
  `text-embedding-3-small` is not comparable to a 0.65 from
  `gemini-embedding-2`.

## See also

- Recipe sources: `recipes/basic-embedding/index.ts`,
  `recipes/multimodal-embedding/index.ts`,
  `recipes/multivector-embedding/index.ts`
- For tool-using conversations: `effect-uai-basic-usage`
