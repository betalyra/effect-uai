---
title: Embedding model
description: One generic service tag, three providers, and the seam between portable and provider-specific vectorization.
---

Search, retrieval, classification, clustering — all of them want to
compare meanings. Embeddings turn that into vector arithmetic.

`EmbeddingModel` is the generic provider tag for that work. Every
provider's `layer` registers itself under both its own typed tag
(`OpenAIEmbedding`, `GeminiEmbedding`, `JinaEmbedding`) *and*
`EmbeddingModel`. Code that yields `EmbeddingModel` is portable across
providers; code that yields the typed tag gets that provider's extended
options (full task enum, sparse / multivector encoding, document title).

This is the same seam the [language model](/concepts/language-model/)
uses. Different shape, same idea.

## The shape

```ts
interface EmbeddingModelService {
  readonly embed: (request: CommonEmbedRequest) => Effect<EmbedResponse, AiError>
  readonly embedMany: (request: CommonEmbedManyRequest) => Effect<EmbedManyResponse, AiError>
}

class EmbeddingModel extends Context.Service<EmbeddingModel, EmbeddingModelService>()(...)
```

Two methods. One vector at a time, or a batch in one HTTP call. The
request bag carries cross-cutting fields:

```ts
interface CommonEmbedRequest {
  readonly input: EmbedInput
  readonly model: string
  readonly task?: "query" | "document"
  readonly dimensions?: number
  readonly encoding?: Encoding
}
```

Anything outside this set (Jina's full task vocabulary, Gemini's
`title`, OpenAI's encoding subset) lives on the provider-specific
request shape, not here.

## Two top-level helpers

```ts
import { embed, embedMany } from "@effect-uai/core/EmbeddingModel"

embed({ model, input })       // Effect<EmbedResponse, AiError, EmbeddingModel>
embedMany({ model, inputs })  // Effect<EmbedManyResponse, AiError, EmbeddingModel>
```

Both yield `EmbeddingModel`, so they work under any provider's layer.
`embedMany` issues one HTTP call for the whole batch — usually cheaper
and faster than N parallel `embed`s, and the only way to get the same
`task` applied uniformly across inputs.

## What you get back

The `Embedding` returned to you is a tagged union — five arms, one for
each wire shape a provider can produce:

| Tag | Shape | When you'd ask for it |
|---|---|---|
| `float32` | `Float32Array` | Default. Universal. |
| `int8` | `Int8Array` | ~4× smaller index, minimal recall loss. |
| `binary` | `Uint8Array` (bit-packed) | ~32× smaller, paired with a float32 reranker pass. |
| `sparse` | `Record<string, number>` | Hybrid (dense + lexical) search. Jina ELSER today. |
| `multivector` | `ReadonlyArray<Float32Array>` | Late-interaction retrieval (ColBERT-style). Jina v4 today. |

The tag reflects the **wire form the provider returned**, not what
you asked for. Type guards narrow when you need them:

```ts
import * as Embedding from "@effect-uai/core/Embedding"

if (Embedding.isFloat32(result.embedding)) {
  // result.embedding.vector is Float32Array
}
```

## Encoding and task

Two cross-cutting request fields shape what comes back:

- **`encoding`** — picks one of the wire shapes above. `float32` is
  the default; provider layers reject unsupported values up front with
  `AiError.InvalidRequest`. Each provider narrows this to its supported
  set on its typed request, so writing
  `OpenAIEmbedRequest` with `encoding: "multivector"` is a compile
  error.
- **`task`** — retrieval-task hint. `"query"` and `"document"` are the
  cross-provider denominator. Cohere requires it on the wire; Jina
  needs it for retrieval-quality results; OpenAI ignores it;
  `gemini-embedding-2` ignores it. For provider-portable retrieval,
  pass it everywhere — it's harmless when ignored.

Provider-specific extensions live on the typed request:
`GeminiEmbedRequest` widens `task` to the full Gemini enum
(`similarity`, `classification`, `clustering`, `qa`, …);
`JinaEmbedRequest` widens it to Jina's dotted-pair vocabulary
(`retrieval.query`, `code.passage`, …).

## Multimodal input

`EmbedInput` is a union covering text, image, and mixed-modality:

```ts
type EmbedInput =
  | string                                      // text shorthand
  | { readonly text: string }                   // text
  | { readonly image: ImageSource }             // image
  | { readonly content: ReadonlyArray<EmbedContentPart> }  // interleaved
```

`ImageSource` is `url` / `base64` / `bytes` — the same media
primitives that language model image inputs use, exported from
`@effect-uai/core/Image`. Not every provider accepts every
variant; the layer rejects what it can't encode. See
[multimodal embedding](/embeddings/multimodal/) for the cross-modal
retrieval scenario.

## Vector math

Once you have an `Embedding`, you compare or rank with `Vector`:

```ts
import * as Vector from "@effect-uai/core/Vector"

Vector.cosine(a, b)        // dense float32 similarity
Vector.dot(a, b)
Vector.euclidean(a, b)
Vector.normalize(v)

Vector.sparseCosine(a, b)  // SparseEmbedding similarity
Vector.sparseDot(a, b)

Vector.maxSim(q, d)        // multivector / late-interaction
```

These are recipe-volume primitives — allocation-free hot loops, but
plain JS. For vector-DB scale (millions of vectors, SIMD, GPU), reach
for a dedicated library or a vector store with native indexing.

## Portable vs. provider-specific

Yield `EmbeddingModel` when your code should work under any provider:

```ts
import { embedMany } from "@effect-uai/core/EmbeddingModel"

const result = yield* embedMany({
  model: "gemini-embedding-2",
  inputs: documents,
  task: "document",
})
```

Yield the typed tag when you need provider-specific options:

```ts
import { GeminiEmbedding } from "@effect-uai/google/GeminiEmbedding"

const program = Effect.gen(function* () {
  const gemini = yield* GeminiEmbedding
  return gemini.embed({
    model: "gemini-embedding-001",
    input: query,
    task: "qa",        // Gemini-only task
    title: "FAQ entry", // Gemini-only field
  })
})
```

The same underlying implementation serves both tags. Mix them in one
program: yield the typed tag for the calls that need extended options,
yield `EmbeddingModel` everywhere else.

## What `EmbeddingModel` is not

- **Not a vector store.** It produces vectors; storing and indexing
  them is userland (or a dedicated DB).
- **Not a reranker.** Cosine on top-K embeddings is an approximation;
  for cross-encoder re-scoring see [reranking](/reranking/) (planned).
- **Not a chunker.** Splitting documents into embeddable units is
  userland — the right strategy depends on your domain.

## Layer registration

Each provider exports a `layer` that registers both tags:

```ts
import { layer as openaiLayer } from "@effect-uai/responses/OpenAIEmbedding"
// Layer<OpenAIEmbedding | EmbeddingModel, never, HttpClient>

import { layer as geminiLayer } from "@effect-uai/google/GeminiEmbedding"
// Layer<GeminiEmbedding | EmbeddingModel, never, HttpClient>

import { layer as jinaLayer } from "@effect-uai/jina/JinaEmbedding"
// Layer<JinaEmbedding | EmbeddingModel, never, HttpClient>
```

Provide one and `EmbeddingModel`-yielding code resolves; the typed
tag also resolves for code that wants extended options. To swap
providers, swap the layer.

## Next step

Try [basic embedding](/recipes/basic-embedding/) — a query, a corpus,
cosine ranking, three swappable providers.

## See also

- [Multimodal embedding](/embeddings/multimodal/) — embed images and
  text in one batch and rank cross-modally.
- [Multivector embedding](/embeddings/multivector/) — late-interaction
  retrieval with Jina v4.
- Provider specifics: [OpenAI](/embeddings/providers/responses/),
  [Gemini](/embeddings/providers/gemini/),
  [Jina](/embeddings/providers/jina/).
