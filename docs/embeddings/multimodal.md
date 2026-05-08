---
title: Multimodal embedding
description: Cross-modal retrieval — embed images and text in one batch, rank either against either.
---

You have a corpus of product photos and product descriptions. A user
uploads an image. You want both kinds of results, ranked by relevance.

This is what a multimodal embedding model is for. Images and text land
in the same vector space, so cosine similarity works across the
boundary — image vs. text, image vs. image, text vs. text — without a
separate captioning pass.

**Scenario.** One image as the query, a corpus mixing images and text.
Rank everything against the query in one cosine sweep.

## One batch, mixed modalities

`embedMany` accepts a `ReadonlyArray<EmbedInput>` where each entry can
be text, image, or a mixed `content[]`:

```ts
import { embedMany } from "@effect-uai/core/EmbeddingModel"
import * as Image from "@effect-uai/core/Image"

const inputs: ReadonlyArray<EmbedInput> = [
  { image: Image.imageBytes(doughBytes, "image/jpeg") },
  { image: Image.imageBytes(dragonBytes, "image/jpeg") },
  { text: "A photo of artisan sourdough bread" },
  { text: "A delicious croissant on a plate" },
]

const result = yield * embedMany({ model: "gemini-embedding-2", inputs })
```

One HTTP call covers the whole batch. The provider returns a
`Float32Embedding` per input in the same order you sent them.

## Cross-modal ranking

A multimodal embedding space lets you compare any pair:

```ts
const [queryResult, docsResult] =
  yield *
  Effect.all(
    [
      embed({ model, input: { image: Image.imageBytes(queryBytes, "image/jpeg") } }),
      embedMany({ model, inputs }),
    ],
    { concurrency: "unbounded" },
  )

const ranked = inputs
  .map((input, i) => ({
    input,
    score: Vector.cosine(queryResult.embedding.vector, docsResult.embeddings[i].vector),
  }))
  .sort((a, b) => b.score - a.score)
```

Same shape as [basic embedding](/recipes/basic-embedding/) — the only
difference is what's in `input` and `inputs`.

## A note on the modality gap

Cross-modal scores are noisier than same-modality scores. In practice
you'll often see image-image cosines clustered higher than image-text
cosines — even when the image-text pairs are semantically closer. This
is the _modality gap_: joint embedding spaces tend to cluster by
modality before clustering by content.

Two practical takeaways:

- **Cosine thresholds don't transfer between modality pairs.** A 0.65
  image-text score might mean strong relevance; a 0.65 image-image
  score might mean unrelated photos that share aesthetic. Calibrate
  thresholds per pair.
- **Rerank for cross-modal precision.** When the modality gap dominates
  your top-K, a cross-encoder reranker that takes both modalities
  (Jina rerank-m0) recovers the ordering.

## Provider support

Today, multimodal embedding lives on:

- **`gemini-embedding-2`** — text, image, audio, video, PDF in one
  vector space. Does not honour `task`; instead, prepend a task
  instruction in the prompt text.
- **`jina-embeddings-v4`** — text + image, retrieval-tuned, also
  supports multivector and sparse output.
- **`jina-clip-v2`** — CLIP-style image/text only.

OpenAI's embedding line is text-only. Cohere v4 and Voyage multimodal
are on the embedding plan but not yet implemented.

## Image input shapes

`ImageSource` is `url` / `base64` / `bytes` — the same primitives
language model image inputs use. Provider acceptance varies:

| Provider | URL                            | Base64 | Bytes             |
| -------- | ------------------------------ | ------ | ----------------- |
| Gemini   | rejected (no Files-API upload) | yes    | yes (auto base64) |
| Jina v4  | yes                            | yes    | yes (auto base64) |

If a layer can't encode the shape you passed, it fails the request
with `AiError.InvalidRequest` — no silent fallback.

## Run it

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/multimodal-embedding/index.ts
```

The full source is at
[`recipes/multimodal-embedding/index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/multimodal-embedding/index.ts).
The recipe fetches three Unsplash images, mixes them with text in one
batch, and ranks against an image query.

## See also

- [Embedding model](/embeddings/) — the concept page.
- [Multivector embedding](/embeddings/multivector/) — token-level
  retrieval when single-vector cosine isn't precise enough.
- [Reranking](/reranking/) (coming soon) — cross-encoder re-scoring
  for cross-modal precision.
