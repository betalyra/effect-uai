---
title: Google Gemini (embeddings)
description: Gemini's embedding API — multimodal on v2, full task enum on v1, Matryoshka throughout.
---

Gemini covers more modalities than any other embedding provider on the
list — text, image, audio, video, PDF — all in one vector space, on
`gemini-embedding-2`. The v1 line stays useful too: text-only but with
the full Google task enum (`SEMANTIC_SIMILARITY`, `CLASSIFICATION`,
`CLUSTERING`, `QUESTION_ANSWERING`, …).

## Install

```sh
pnpm add @effect-uai/core @effect-uai/google effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as geminiEmbeddingLayer } from "@effect-uai/google/GeminiEmbedding"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return geminiEmbeddingLayer({ apiKey })
  }),
)

const runtime = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`geminiEmbeddingLayer` registers two service tags from one underlying
implementation:

- **`GeminiEmbedding`** — the typed tag. Yield this when you want the
  full task enum, document `title`, or the typed model union.
- **`EmbeddingModel`** — the generic tag for provider-portable code.

## Request shape

```ts
interface GeminiEmbedRequest extends Omit<CommonEmbedRequest, "model" | "task" | "encoding"> {
  readonly model: GoogleEmbeddingModel
  readonly task?: GoogleEmbeddingTask
  readonly title?: string
  readonly dimensions?: number
}

type GoogleEmbeddingTask =
  | "query" | "document"        // cross-provider denominator
  | "similarity" | "classification" | "clustering"
  | "qa" | "fact_verification" | "code_query"
```

- **`task`** — Gemini's full task enum. Mapped internally to wire
  values (`RETRIEVAL_QUERY`, `SEMANTIC_SIMILARITY`, …). Honoured by
  `gemini-embedding-001`. **Ignored** by `gemini-embedding-2` — that
  model expects task hints as prefix text in the prompt itself.
- **`title`** — optional document title for `RETRIEVAL_DOCUMENT` tasks
  on `gemini-embedding-001`. Ignored elsewhere.
- **`dimensions`** — Matryoshka truncation. `gemini-embedding-2`
  supports 128–3072; `gemini-embedding-001` supports 128/256/512/1408.

## Calling it

Multimodal call on v2:

```ts
import { GeminiEmbedding } from "@effect-uai/google/GeminiEmbedding"
import * as Image from "@effect-uai/core/Image"

const program = Effect.gen(function* () {
  const gemini = yield* GeminiEmbedding
  return gemini.embedMany({
    model: "gemini-embedding-2",
    inputs: [
      { text: "A photo of artisan sourdough bread" },
      { image: Image.imageBytes(jpegBytes, "image/jpeg") },
    ],
  })
})
```

Task-typed call on v1:

```ts
const program = Effect.gen(function* () {
  const gemini = yield* GeminiEmbedding
  return gemini.embed({
    model: "gemini-embedding-001",
    input: "What is the boiling point of water?",
    task: "qa",
    title: "Physics FAQ",
  })
})
```

## Models

`GoogleEmbeddingModel` is a literal union with a `(string & {})` tail:

| Model | Modalities | Task field | Native dims |
|---|---|---|---|
| `gemini-embedding-2` | text, image, audio, video, PDF | ignored (use prefix) | up to 3072 |
| `gemini-embedding-001` | text only | full enum | 128/256/512/1408 |

Reference: [Gemini embeddings docs](https://ai.google.dev/gemini-api/docs/embeddings).

## Encoding support

| `encoding` | Behaviour |
|---|---|
| `float32` (default) | Native float32 from `embedding.values`. |
| `int8` / `binary` | Rejected — Gemini doesn't ship quantized output. |
| `sparse` / `multivector` | Rejected — same. |

If you need quantized vectors against a Gemini index,
[Jina](/embeddings/providers/jina/) ships `binary` natively.

## Image input shapes

Gemini's embed endpoint takes inline base64. The layer accepts:

- **`base64`** — passed through.
- **`bytes`** — auto-encoded to base64.
- **`url`** — rejected with `AiError.InvalidRequest`. Pre-uploading
  via Google's Files API isn't free, so URL-form image inputs fail
  fast rather than silently doing extra work. Fetch the bytes and pass
  `imageBytes(...)` instead.

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

Gemini's embed endpoints don't return token-count metadata, so
`usage.inputTokens` comes back `undefined` rather than estimated.

## See also

- [Embedding model](/embeddings/) — the cross-provider concept.
- [Multimodal embedding](/embeddings/multimodal/) — recipe and details
  on the modality gap.
- [Gemini language model](/providers/gemini/) — the same provider's
  `streamGenerateContent` integration.
