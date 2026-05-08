---
title: Responses / OpenAI (embeddings)
description: OpenAI's embedding API — text-only, Matryoshka dimensions, two model sizes.
---

OpenAI's embedding line is the boring, dependable choice — text in,
dense float32 vectors out, nothing fancier. Two sizes, Matryoshka
truncation, no task semantics. If you want sparse, multivector, or
images, see [Jina](/embeddings/providers/jina/) or
[Gemini](/embeddings/providers/gemini/).

## Install

```sh
pnpm add @effect-uai/core @effect-uai/responses effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as openaiEmbeddingLayer } from "@effect-uai/responses/OpenAIEmbedding"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return openaiEmbeddingLayer({ apiKey })
  }),
)

const runtime = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`openaiEmbeddingLayer` registers two service tags from one underlying
implementation:

- **`OpenAIEmbedding`** — the typed tag. Yield this when you want the
  OpenAI-typed model union and the narrow request shape.
- **`EmbeddingModel`** — the generic tag. Yield this in
  provider-portable code.

## Request shape

```ts
interface OpenAIEmbedRequest extends Omit<CommonEmbedRequest, "model" | "task"> {
  readonly model: OpenAIEmbeddingModel
  readonly dimensions?: number
  readonly encoding?: Encoding
}
```

Note what's *not* there: **no `task`**. OpenAI's embedding API has no
task-type semantics, so the field is omitted from the typed request —
passing it is a compile error. The generic `EmbeddingModel` tag accepts
and silently ignores `task` so portable code keeps working.

`dimensions` is Matryoshka truncation: pass any value from `1` to the
model's native dimensionality and the server truncates the vector to
that length. Useful when your downstream index has a fixed dim budget.

## Calling it

```ts
import { OpenAIEmbedding } from "@effect-uai/responses/OpenAIEmbedding"

const program = Effect.gen(function* () {
  const oai = yield* OpenAIEmbedding
  return oai.embedMany({
    model: "text-embedding-3-small",
    inputs: documents,
    dimensions: 512, // Matryoshka truncation
  })
})
```

Or via the generic tag:

```ts
import { embedMany } from "@effect-uai/core/EmbeddingModel"

const result = yield* embedMany({
  model: "text-embedding-3-small",
  inputs: documents,
})
```

## Models

`OpenAIEmbeddingModel` is a literal union with a `(string & {})` tail:

| Model | Native dims | Matryoshka |
|---|---|---|
| `text-embedding-3-small` | 1536 | 1..1536 |
| `text-embedding-3-large` | 3072 | 1..3072 |
| `text-embedding-ada-002` | 1536 | no |

Reference: [OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings).

## Encoding support

| `encoding` | Behaviour |
|---|---|
| `float32` (default) | Native JSON `number[]` decoding. |
| `int8` / `binary` | Rejected at the OpenAI API. |
| `sparse` / `multivector` | Rejected at the OpenAI API. |

For storage-cost reductions, do float32 → int8 / binary quantization
on your side, or pick a provider that ships quantized output natively
(Jina, Cohere, Voyage).

## Input shapes

OpenAI's embedding endpoint takes a single text string per input. The
layer accepts the full `EmbedInput` union for parity, with these
behaviours:

- **`string`** — passed through.
- **`{ text }`** — passed through.
- **`{ image }`** — rejected with `AiError.InvalidRequest`.
- **`{ content: [...] }`** — text parts concatenated with newlines,
  any image part rejected.

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

Recover per-tag with `Effect.catchTag("RateLimited", handler)`.

## See also

- [Embedding model](/embeddings/) — the cross-provider concept.
- [Basic embedding](/recipes/basic-embedding/) — runnable example
  with a `--provider=openai` switch.
- [OpenAI language model](/providers/responses/) — the same provider's
  Responses API integration.
