---
title: Jina (embeddings)
description: Jina's embedding API — multimodal, multilingual, sparse, multivector, binary quantization.
---

Jina's embedding line covers ground no other provider on the list does:
**sparse** vectors for hybrid search (`elser-v2`), **multivector** late
interaction (`jina-embeddings-v4`), and binary-quantized output for
storage-tight indexes — alongside the standard text + image dense
retrieval models.

If embedding is the only thing you need from a provider, Jina is the
broadest single surface. (Reranking is on the roadmap and uses the same
auth — see [reranking](/reranking/).)

## Install

```sh
pnpm add @effect-uai/core @effect-uai/jina effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as jinaEmbeddingLayer } from "@effect-uai/jina/JinaEmbedding"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("JINA_API_KEY")
    return jinaEmbeddingLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`jinaEmbeddingLayer` registers two service tags from one underlying
implementation:

- **`JinaEmbedding`** — the typed tag. Yield this for the full Jina
  task vocabulary and the narrow encoding union.
- **`EmbeddingModel`** — the generic tag for provider-portable code.
  The generic registration maps cross-provider `"query"` / `"document"`
  to Jina's `retrieval.query` / `retrieval.passage`.

## Request shape

```ts
interface JinaEmbedRequest extends Omit<CommonEmbedRequest, "model" | "task" | "encoding"> {
  readonly model: JinaEmbeddingModel
  readonly task?: JinaTask
  readonly encoding?: JinaEncoding
  readonly dimensions?: number
}

type JinaTask =
  | "retrieval.query"
  | "retrieval.passage" // asymmetric retrieval
  | "text-matching" // symmetric
  | "code.query"
  | "code.passage" // v4 code retrieval
  | "classification"
  | "separation" // v3 / v5
  | (string & {})

type JinaEncoding = "float32" | "binary" | "sparse" | "multivector"
```

The `(string & {})` tail on `JinaTask` accepts any string so newly
released task names work without an SDK update.

## Calling it

Late-interaction (multivector) retrieval:

```ts
import { JinaEmbedding } from "@effect-uai/jina/JinaEmbedding"

const program = Effect.gen(function* () {
  const jina = yield* JinaEmbedding
  return jina.embedMany({
    model: "jina-embeddings-v4",
    inputs: documents,
    task: "retrieval.passage",
    encoding: "multivector",
  })
})
```

Binary-quantized dense retrieval:

```ts
const result =
  yield *
  jina.embed({
    model: "jina-embeddings-v4",
    input: query,
    task: "retrieval.query",
    encoding: "binary", // ~32× smaller than float32
  })
```

Sparse hybrid retrieval (ELSER-style):

```ts
const result =
  yield *
  jina.embed({
    model: "elser-v2",
    input: query,
    encoding: "sparse",
  })
// result.embedding._tag === "sparse"
// result.embedding.weights is Record<string, number>
```

Score sparse vectors with `Vector.sparseCosine`; multivector with
`Vector.maxSim`; dense with `Vector.cosine`.

## Models

`JinaEmbeddingModel` is a literal union with a `(string & {})` tail:

| Model                           | Modalities  | Encodings                    | Notes                                    |
| ------------------------------- | ----------- | ---------------------------- | ---------------------------------------- |
| `jina-embeddings-v4`            | text, image | float32, binary, multivector | Flagship, 32k context, LoRA-bound tasks. |
| `jina-embeddings-v5-text-small` | text        | float32, binary              | Multilingual, GGUF-quantizable.          |
| `jina-embeddings-v5-text-nano`  | text        | float32, binary              | Edge-deployable.                         |
| `jina-embeddings-v3`            | text        | float32, binary              | Legacy text-only.                        |
| `jina-clip-v2`                  | image, text | float32, binary              | CLIP-style multimodal.                   |

`elser-v2` (learned sparse) is also accessible via the `(string & {})`
tail; pass `encoding: "sparse"` to receive token-keyed weights.

Reference: [Jina embeddings](https://jina.ai/embeddings/).

## Encoding support

| `encoding`          | Wire behaviour                                        |
| ------------------- | ----------------------------------------------------- |
| `float32` (default) | Default JSON `number[]`.                              |
| `binary`            | `embedding_type: "binary"` — bit-packed `Uint8Array`. |
| `sparse`            | No flag; the chosen model decides (e.g. `elser-v2`).  |
| `multivector`       | `return_multivector: true` — one vector per token.    |

Compatibility is checked at the **response level**, not via a
hardcoded model-encoding table. If you ask for an encoding the chosen
model doesn't produce, the layer fails with a typed
`AiError.InvalidRequest` ("requested encoding=… but the response
contains a … embedding"). New models work without an SDK update.

## Image input shapes

Jina v4 accepts URL or base64 image inputs:

- **`url`** — passed through; Jina fetches.
- **`base64`** — passed through.
- **`bytes`** — auto-encoded to base64.

Mixed `content[]` inputs with multiple parts are rejected — Jina's
flat `input[]` would lose the grouping. Split into separate `inputs[]`
entries.

## Errors

HTTP failures map to typed `AiError` variants:

| Status      | Error                               |
| ----------- | ----------------------------------- |
| `429`       | `AiError.RateLimited`               |
| `408`/`504` | `AiError.Timeout`                   |
| `401`       | `AiError.AuthFailed` (`auth`)       |
| `403`       | `AiError.AuthFailed` (`permission`) |
| `402`       | `AiError.AuthFailed` (`billing`)    |
| `413`       | `AiError.ContextLengthExceeded`     |
| `>= 500`    | `AiError.Unavailable`               |
| other 4xx   | `AiError.InvalidRequest`            |

Encoding-mismatch (the chosen model didn't produce the requested
encoding) maps to `AiError.InvalidRequest` with `param: "encoding"`.

## See also

- [Embedding model](/embeddings/) — the cross-provider concept.
- [Multivector embedding](/embeddings/multivector/) — late-interaction
  scenario built on `jina-embeddings-v4`.
- [Reranking](/reranking/) — coming soon, same provider, same auth.
