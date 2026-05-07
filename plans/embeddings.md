# Embeddings — Design Plan

Status: design draft, not yet implemented.

We're adding an `Embeddings` service abstraction with provider
implementations. Rerank lands next; this plan keeps it in mind but
defers it.

## Scope

In scope:

- `embedQuery`, `embedDocument`, `embedMany` in core.
- Multimodal input (text + image) from day one.
- Per-provider task / input type values surfaced in the type system.
- Quantized output (int8 / binary) as an opt-in.
- Provider layers for OpenAI, Google (Gemini API + Vertex), Voyage,
  Cohere, Jina, Mixedbread.
- Reuse existing provider packages (`@effect-uai/responses`,
  `@effect-uai/google`) for providers that already ship a
  `LanguageModel` layer; new packages for embedding-only providers.

Out of scope (for v1):

- Rerank — sibling service, separate plan.
- Sparse vectors — Jina v4 only on hosted APIs; defer.
- Multivector / late-interaction (Jina v4 ColBERT-style) — defer.
- Streaming embed — no provider supports it; recipe-level if needed.
- Chunking helpers — userland.
- Vector stores — userland.
- Local / self-hosted (Ollama, TEI) — userland.
- Batching / rate-limit policies — recipe, not core.

## Provider survey

### Comparison table

| Provider     | Text | Image | Task / Input Type                                               | Output Formats                                                          | Sparse | Matryoshka                                            | Max Batch | Max Tokens |
| ------------ | ---- | ----- | --------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ | ----------------------------------------------------- | --------- | ---------- |
| OpenAI       | yes  | no    | none                                                            | `float`, `base64`                                                       | no     | yes (3-large 1..3072, 3-small 1..1536)                | 2048      | 8191       |
| Cohere v4    | yes  | yes   | `input_type` required: `search_query` / `search_document` / `classification` / `clustering` / `image` | `float`, `int8`, `uint8`, `binary`, `ubinary`, `base64`                 | no     | yes (256/512/1024/1536, discrete)                     | 96        | 128k       |
| Voyage       | yes  | yes   | `input_type`: `query` / `document` / null                       | `float`, `int8`, `uint8`, `binary`, `ubinary` (`output_dtype`); `base64` | no     | yes (256/512/1024/2048, model-specific)               | 1000      | 32k        |
| Jina v3      | yes  | no    | `task`: `retrieval.query` / `retrieval.passage` / `text-matching` / `classification` / `separation` | `float`, `base64`, `binary`, `ubinary`                                  | no     | yes (down to 32)                                      | soft      | 8192       |
| Jina v4      | yes  | yes   | `task` (LoRA-bound)                                             | dense / multivector / **sparse** (`return_sparse`)                      | yes    | yes (down to 128)                                     | soft      | 32768      |
| Mixedbread   | yes  | (lim) | `prompt` (free-form prefix)                                     | `float`, `base64`, `int8`, `uint8`, `binary`, `ubinary`                 | no     | yes (MRL implicit)                                    | provider  | model-spec |
| Gemini API   | yes  | v2 only | `taskType` enum (incl. `CODE_RETRIEVAL_QUERY`); v2 uses prefix | dense float                                                             | no     | yes (`outputDimensionality` 128–3072)                 | ~100      | 2048 / 8192|
| Vertex AI    | yes  | yes   | matches Gemini API; `multimodalembedding@001` is task-free       | dense float                                                             | no     | yes (128/256/512/1408 or 128–3072)                    | ~5        | 8192       |

### Convergence points

- **Query vs document is the universal task axis.** Cohere `search_query`/`search_document`, Voyage `query`/`document`, Google `RETRIEVAL_QUERY`/`RETRIEVAL_DOCUMENT`, Jina `retrieval.query`/`retrieval.passage`. The long tail (`classification`, `clustering`, `CODE_RETRIEVAL_QUERY`, Mixedbread free-form `prompt`) is provider-specific.
- **Multimodal converges on a `content[]`-of-parts shape.** Cohere v4 `inputs[].content[]`, Voyage multimodal `inputs[].content[]`, Jina v4 `input[]` of `{text|image}`, Gemini `content.parts[]`. One TS union maps cleanly to all.
- **Sparse is essentially Jina v4 only.** Cohere/Voyage "binary" labels are dense quantization, not sparse.
- **Quantization is broadly supported** (Cohere, Voyage, Jina, Mixedbread) — meaningful storage win at vector-DB scale.
- **`dimensions` is a request parameter** for everyone except Mixedbread (implicit MRL). Discrete-value providers (Cohere, Vertex `multimodalembedding@001`) validate at the layer.

### Rerank API shape (forward look)

All four rerank-capable providers (Cohere, Jina, Voyage, Mixedbread) converge on:

```
POST /rerank
{ model, query, documents, top_n?, return_documents? }
→ { results: [{ index, relevance_score }] }
```

Wire shape is unrelated to embeddings. Same auth/HTTP client as embed. → **Reranker is a sibling service, sharing the per-provider `*Client` layer only.** No shared base interface.

## Existing-art sanity check

### `@effect/ai` (Effect 3) — `EmbeddingModel.ts`

```ts
interface Service {
  embed:     (input: string)                    => Effect<Array<number>, AiError>
  embedMany: (inputs: ReadonlyArray<string>, opts?: { concurrency? })
                                                => Effect<Array<Array<number>>, AiError>
}
```

- `make({ embedMany, maxBatchSize?, cache? })` factory uses `RequestResolver.makeBatched` → single `embed` calls auto-coalesce into one HTTP batch. **Excellent infrastructure, reuse pattern as-is.**
- Per-call provider config (`dimensions`, `encoding_format`, `input_type`) flows via `withConfigOverride` + `Context.Tag`, **invisible at the call site**.
- Models narrowed via generated string-literal unions, but multimodal vs text-only models aren't type-distinguished.

**Gaps for our requirements:**

1. String-only input — no path to multimodal without breaking the type.
2. `Array<number>` only — no quantized, no sparse, no `Float32Array`.
3. No first-class task / input type. Pushed into `Config` overrides — the most common decision (query vs document) hides in a docs lookup.
4. No first-class `dimensions`.

### effect-smol (Effect 4) — `packages/effect/src/unstable/ai/EmbeddingModel.ts`

```ts
class EmbeddingModel extends Context.Service<EmbeddingModel, Service>()("effect/unstable/ai/EmbeddingModel") {}
class Dimensions    extends Context.Service<Dimensions, number>()        ("effect/unstable/ai/EmbeddingModel/Dimensions") {}

interface Service {
  resolver:  RequestResolver.RequestResolver<EmbeddingRequest>
  embed:     (input: string)                    => Effect<EmbedResponse, AiError>
  embedMany: (input: ReadonlyArray<string>)     => Effect<EmbedManyResponse, AiError>
}

class EmbedResponse     { vector: ReadonlyArray<number> }
class EmbedManyResponse { embeddings: ReadonlyArray<EmbedResponse>; usage: EmbeddingUsage }
```

Structurally identical to v3 — just relocated to core's `unstable/ai/*` namespace and ported to Effect 4's `Context.Service` / `RequestResolver`. **Same gaps.** Only OpenAI + OpenAI-compat providers exist; no Anthropic, no Google.

**Conclusion: porting to v4 doesn't move the design needle.** The surface needs redesign either way to meet our requirements. We mirror their batching/resolver internals but build our own surface.

## Usage scenarios

Walking the actual workloads to anchor the design:

| # | Scenario                                  | Volume       | Inputs    | Task                | Batch shape               |
| - | ----------------------------------------- | ------------ | --------- | ------------------- | ------------------------- |
| 1 | Offline RAG indexing                      | 1k–10M       | many      | `document`          | one task per batch        |
| 2 | Online query embedding (RAG retrieval)    | high QPS     | 1         | `query`             | n/a                       |
| 3 | Search tool called by an agent (this lib) | per LLM turn | 1         | `query`             | n/a                       |
| 4 | Multi-query / HyDE expansion              | small        | K         | one task            | one task per batch        |
| 5 | Classification / clustering / dedup       | 100s–10k     | many      | `classification` …  | one task per batch        |
| 6 | Semantic similarity (A vs B)              | 2            | 2         | one task            | one task per batch        |
| 7 | Embed-and-cosine "rerank"                 | rare         | 1 + N     | mixed               | **use `Reranker` instead**|

**Key takeaway**: every workload that exists in practice is single-task per batch, or single-input. Mixed-task batches (scenario 7) are exactly what dedicated rerankers (Cohere/Jina/Voyage/Mixedbread `/rerank`) are for, and we're shipping `Reranker` next anyway. **No need to support per-input task variation.**

## Design recommendations

### Task → single value applied to whole batch

`task: "query" | "document"` lives on the request, applied to every input in the batch. Mirrors the wire shape of every provider:

- Cohere/Voyage/Jina/Mixedbread: one `input_type` / `task` / `prompt` per HTTP request.
- OpenAI: ignores task entirely.
- Google `batchEmbedContents`: technically per-input, but we set every per-input `taskType` to the request's `task` — flexibility is an implementation detail, not surface area.

For the long tail (Cohere `classification`/`clustering`/`image`, Jina `text-matching`/`separation`, Google `CODE_RETRIEVAL_QUERY`, Mixedbread free-form `prompt`), provider-typed requests *widen* the `task` field to the full provider enum. Same trick `GeminiRequest` uses to add `thinkingBudget` to `CommonRequest`.

**Rejected**: separate `embedQuery` / `embedDocument` methods + `embedWith` escape hatch. Three concerns conflated (single-vs-batch, query-vs-document, generic-vs-provider-task) into four method names. Single `task` field on the request handles all three.

**Rejected**: per-input task arrays. No real workload needs it; would either lie about wire cost (auto-fanout to N HTTP calls) or expose a Google/Jina-only feature in the cross-provider type.

### Two methods → `embed` (single) + `embedMany` (batch)

```ts
embed:     (request: EmbedRequest)     => Effect<EmbedResponse,     AiError>
embedMany: (request: EmbedManyRequest) => Effect<EmbedManyResponse, AiError>
```

Each method maps to one HTTP call; `embed` sends one input, `embedMany` sends N. No auto-batching across concurrent `embed` invocations — callers that want that build it with `Effect.all` and concurrency. Mirrors `@effect/ai` and effect-smol's surface (without their resolver-based coalescing).

Reasons (in priority order):

1. **Honest about cost.** Single takes one input, batch takes an array. The method you call is the wire shape.
2. **Cleaner response struct.** `embed` returns `{ embedding, usage }`; `embedMany` returns `{ embeddings, usage }`. `usage` is one value per HTTP call, not per-vector — the response shape reflects that.
3. **Convention.** Every Effect-aware embeddings API ships these two methods; users coming from `@effect/ai` find the same surface.

**Rejected**: polymorphic `embed(input | input[]) → vector | vector[]`. TS overload typing breaks composition (`pipe`, `Effect.flatMap`), no place for `usage` metadata, and `EmbedInput` is already a discriminated union — adding `| ReadonlyArray<EmbedInput>` at the top makes runtime discrimination messy.

**Rejected**: `RequestResolver.makeBatched` auto-batching. Adds a non-trivial moving part (batch window, key-equality across requests, partial-batch failure semantics) for a use case (concurrent `embed(single)` calls) that callers can solve trivially with `Effect.all(... , { concurrency: N })` over `embedMany` chunks. Out of scope for v1; can be added later as a recipe.

### Multimodal input → discriminated union

```ts
type EmbedInput =
  | string                                    // shorthand for { text }
  | { readonly text: string }
  | { readonly image: ImageSource }
  | { readonly content: ReadonlyArray<EmbedContentPart> }   // mixed text+image

type EmbedContentPart =
  | { readonly text: string }
  | { readonly image: ImageSource }

type ImageSource =
  | { readonly url: string }
  | { readonly base64: string;   readonly mimeType: string }
  | { readonly bytes: Uint8Array; readonly mimeType: string }
```

Each provider layer normalizes (`bytes` → base64 data URI for Cohere, GCS upload for Vertex, etc.) — don't try to express provider-specific URL constraints in the type. Audio/video extend the union later, non-breaking.

### Output → discriminated `Embedding`, dense-only for v1

```ts
type Embedding =
  | { readonly kind: "float32"; readonly vector: Float32Array }
  | { readonly kind: "int8";    readonly vector: Int8Array }
  | { readonly kind: "binary";  readonly vector: Uint8Array }
```

- `Float32Array` over `number[]` — every consumer (cosine sim, dot product, vector DB upload) wants typed arrays; base64 → Float32Array decode is cheap.
- Quantized variants opt-in via `encoding?: "float32" | "int8" | "binary"` on the request.
- Sparse deferred — adding `{ kind: "sparse"; indices: Uint32Array; values: Float32Array }` later is non-breaking.

### Dimensions → request parameter, not model metadata

Lives on the request: `{ dimensions?: number }`. Default → provider's default. Discrete-value providers (Cohere, Vertex `multimodalembedding@001`) validate at the layer. Reasoning: dimensions are a per-collection runtime decision, not a model property.

### Sparse → defer

Only Jina v4 ships true sparse on hosted APIs. Modeling sparse in core for one provider is over-engineering. Adding `{ kind: "sparse"; indices, values }` later is non-breaking.

### Rerank → sibling service

Separate `Reranker` `Context.Service`. Shares the per-provider `*Client` layer, nothing else. Multimodal rerank documents reuse the `EmbedContentPart` union — that's the only useful sharing, and types are free.

## Packaging

Per the user's choice (option c) — mirror the `LanguageModel` packaging.

**In scope for this milestone:**

- **`@effect-uai/core`** — defines `EmbeddingModel` service, `CommonEmbedRequest` / `CommonEmbedManyRequest`, `EmbedInput` / `Embedding` types, `RequestResolver`-based batching helper.
- **`@effect-uai/google`** — adds embeddings layer + `GoogleEmbeddingModel` literal union. Targets the Gemini API (`generativelanguage.googleapis.com`) — same base URL, auth, and model namespace as the existing `LanguageModel` layer in [`Gemini.ts`](packages/providers/google/src/Gemini.ts). Endpoints: `models/{model}:embedContent` (single) and `models/{model}:batchEmbedContents` (batch). Vertex is a separate concern, not needed here.
- **`@effect-uai/responses`** — adds an OpenAI embeddings layer + `OpenAIEmbeddingModel` literal union, alongside the existing `Responses` LanguageModel.
- **`@effect-uai/jina`** (new) — embeddings + (later) rerank.
- **`@effect-uai/mixedbread`** (new) — embeddings + (later) rerank.

**Deferred to a later milestone:**

- **`@effect-uai/voyage`** — embeddings + rerank.
- **`@effect-uai/cohere`** — embeddings + rerank.
- **`@effect-uai/anthropic`** — no embeddings layer (Anthropic doesn't ship embeddings; recommends Voyage).

## First-cut TS contract

Mirrors [`LanguageModel.ts`](packages/core/src/language-model/LanguageModel.ts) pattern: one `Common*Request` struct, generic service tag, top-level effect helpers, provider-specific layer registers both the typed tag and the generic tag.

```ts
// packages/core/src/embedding-model/EmbeddingModel.ts
import { Context, Effect } from "effect"
import * as AiError from "../domain/AiError.js"

export type ImageSource =
  | { readonly url:    string }
  | { readonly base64: string;     readonly mimeType: string }
  | { readonly bytes:  Uint8Array; readonly mimeType: string }

export type EmbedContentPart =
  | { readonly text:  string }
  | { readonly image: ImageSource }

export type EmbedInput =
  | string
  | { readonly text:    string }
  | { readonly image:   ImageSource }
  | { readonly content: ReadonlyArray<EmbedContentPart> }

export type Embedding =
  | { readonly kind: "float32"; readonly vector: Float32Array }
  | { readonly kind: "int8";    readonly vector: Int8Array }
  | { readonly kind: "binary";  readonly vector: Uint8Array }

export interface Usage {
  readonly inputTokens?: number
}

/**
 * Cross-provider single-embed request. Provider-specific extensions (Cohere
 * widened `task` enum, Jina LoRA tasks, …) live in that provider's own
 * request interface, which extends this and narrows `model` / widens `task`.
 */
export interface CommonEmbedRequest {
  readonly input:       EmbedInput
  readonly model:       string                          // narrowed per-provider
  readonly task?:       "query" | "document"            // one value; OpenAI ignores
  readonly dimensions?: number
  readonly encoding?:   "float32" | "int8" | "binary"
}

export interface CommonEmbedManyRequest extends Omit<CommonEmbedRequest, "input"> {
  readonly inputs: ReadonlyArray<EmbedInput>
}

export interface EmbedResponse {
  readonly embedding: Embedding
  readonly usage:     Usage
}

export interface EmbedManyResponse {
  readonly embeddings: ReadonlyArray<Embedding>
  readonly usage:      Usage
}

export interface EmbeddingModelService {
  readonly embed:     (request: CommonEmbedRequest)     => Effect.Effect<EmbedResponse,     AiError.AiError>
  readonly embedMany: (request: CommonEmbedManyRequest) => Effect.Effect<EmbedManyResponse, AiError.AiError>
}

export class EmbeddingModel extends Context.Service<EmbeddingModel, EmbeddingModelService>()(
  "@betalyra/effect-uai/EmbeddingModel",
) {}

/** Embed a single input. */
export const embed = (
  request: CommonEmbedRequest,
): Effect.Effect<EmbedResponse, AiError.AiError, EmbeddingModel> =>
  Effect.flatMap(EmbeddingModel.asEffect(), (m) => m.embed(request))

/** Embed a batch in one provider call. Same `task` for every input. */
export const embedMany = (
  request: CommonEmbedManyRequest,
): Effect.Effect<EmbedManyResponse, AiError.AiError, EmbeddingModel> =>
  Effect.flatMap(EmbeddingModel.asEffect(), (m) => m.embedMany(request))
```

**Per-provider model literal** — exact mirror of [`google/models.ts`](packages/providers/google/src/models.ts):

```ts
// packages/providers/jina/src/models.ts
export type JinaEmbeddingModel =
  | "jina-embeddings-v4"
  | "jina-embeddings-v3"
  | "jina-clip-v2"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
```

**Provider service + layer (Jina example)** — exact mirror of [`Gemini.ts`](packages/providers/google/src/Gemini.ts) / [`Responses.ts`](packages/providers/responses/src/Responses.ts):

```ts
// packages/providers/jina/src/JinaEmbedding.ts
export type JinaTask =
  | "query"           // wire: retrieval.query
  | "document"        // wire: retrieval.passage
  | "text-matching"
  | "classification"
  | "separation"

export interface JinaEmbedRequest extends Omit<CommonEmbedRequest, "model" | "task"> {
  readonly model: JinaEmbeddingModel
  readonly task:  JinaTask                       // required for v3+; widened beyond query/document
}

export interface JinaEmbedManyRequest extends Omit<JinaEmbedRequest, "input"> {
  readonly inputs: ReadonlyArray<EmbedInput>
}

export interface JinaEmbeddingService {
  readonly embed:     (request: JinaEmbedRequest)     => Effect.Effect<EmbedResponse,     AiError.AiError>
  readonly embedMany: (request: JinaEmbedManyRequest) => Effect.Effect<EmbedManyResponse, AiError.AiError>
}

export class JinaEmbedding extends Context.Service<JinaEmbedding, JinaEmbeddingService>()(
  "@betalyra/effect-uai/providers/jina/JinaEmbedding",
) {}

export const layer = (
  cfg: Config,
): Layer.Layer<JinaEmbedding | EmbeddingModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(JinaEmbedding, make(cfg))
  const generic = Layer.effect(
    EmbeddingModel,
    Effect.map(make(cfg), (s): EmbeddingModelService => ({
      embed:     (req) => s.embed(req as JinaEmbedRequest),
      embedMany: (req) => s.embedMany(req as JinaEmbedManyRequest),
    })),
  )
  return Layer.merge(typed, generic)
}
```

Yield `JinaEmbedding` for the full task enum (LoRA-bound); yield `EmbeddingModel` for provider-portable code that only needs `query`/`document`.

## Module layout

Per-modality co-location. Each modality (language model, embedding model, future TTS / STT / S2S) keeps its own data types alongside its service:

```
packages/core/src/
  domain/                 only cross-modality types (AiError today)
  language-model/         LanguageModel.ts (today: imports Items / Turn / Tool / Outcome from domain/)
  embedding-model/        EmbeddingModel.ts + Embedding, EmbedInput, ImageSource, Usage
  loop/                   cross-modality orchestration
  …
```

Embedding-side files for this milestone:

- `packages/core/src/embedding-model/EmbeddingModel.ts` — service + `Common*Request` / `Embed*Response` + top-level effect helpers.
- `packages/core/src/embedding-model/Embedding.ts` — `Embedding` (vector) discriminated union, `Usage`.
- `packages/core/src/embedding-model/Input.ts` — `EmbedInput`, `EmbedContentPart`, `ImageSource`.

LM-side cleanup is **out of scope** for this plan but worth a follow-up: `domain/Items.ts`, `domain/Turn.ts`, `domain/Tool.ts`, `domain/Outcome.ts`, `domain/ToolEvent.ts`, `domain/StructuredFormat.ts` are LM-specific and would move into `language-model/` once we touch them. `domain/AiError.ts` stays — it's genuinely cross-modality. Speech modalities, when added, get their own folders the same way.

## Resolved decisions

1. **Google packaging — Gemini API only.** Same base URL / auth as the existing `Gemini.ts` `LanguageModel`. Vertex is not in scope.
2. **`task` defaulting — provider-specific.** Optional in `CommonEmbedRequest` (OpenAI ignores, Mixedbread doesn't have it). Required where the wire requires it (e.g. Jina v3+).
3. **Auto-batching — out of scope.** No `RequestResolver` coalescing. `embed` is one HTTP call; `embedMany` is one HTTP call. Concurrent batching is userland (`Effect.all` over `embedMany` chunks).
4. **Naming — `EmbeddingModel` + `Embedding`.** Matches `LanguageModel` for the service; `Embedding` is the vector value.
5. **Module split — co-locate.** Embedding types live under `embedding-model/` (not `domain/`). Future-proofs the layout for TTS / STT / S2S.

## Implementation order

This milestone:

1. **Core** in `@effect-uai/core/embedding-model/` — `Input.ts` (`EmbedInput`, `EmbedContentPart`, `ImageSource`), `Embedding.ts` (vector union, `Usage`), `EmbeddingModel.ts` (service tag, `Common*Request`, `Embed*Response`, top-level `embed` / `embedMany` helpers). No providers, no auto-batching.
2. **Google** in `@effect-uai/google` — `content.parts[]` request shape, multimodal from day one (`gemini-embedding-2`). Stress-tests `EmbedInput` early; Gemini API only (no Vertex).
3. **OpenAI** in `@effect-uai/responses` — simplest provider (no task, no multimodal). Validates the cross-provider shape on a minimal surface and the LM-style `Responses | EmbeddingModel` layer co-registration.
4. **Jina** (new package `@effect-uai/jina`) — task-as-LoRA, multimodal in v4. Exercises the typed-tag pattern with widened `task` and the multimodal input union end-to-end.
5. **Mixedbread** (new package `@effect-uai/mixedbread`) — `prompt` as free-form task (replaces `task` field). Exercises the most provider-divergent shape; validates that the `Omit<…, "task">` trick scales.
6. **Recipe — basic embedding usage**: one runnable that embeds a query (`task: "query"`) and a small set of documents (`task: "document"`) using `Effect.all` with `concurrency: "unbounded"`, computes cosine similarity in plain TS, prints the ranked list. No vector DB, no chunker, no reranker — just `embed` / `embedMany` end-to-end against a real provider.

Deferred to a later milestone:

- **Voyage** (`@effect-uai/voyage`) provider.
- **Cohere** (`@effect-uai/cohere`) provider.
- **RAG retrieval recipe** (with chunker + vector store + reranker).
- **Indexing-pipeline recipe** (large-scale batched embed + retry policy).

## Sources

- [`@effect/ai` `EmbeddingModel.ts`](https://github.com/Effect-TS/effect/blob/main/packages/ai/ai/src/EmbeddingModel.ts)
- [effect-smol `unstable/ai/EmbeddingModel.ts`](https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/unstable/ai/EmbeddingModel.ts)
- [effect-smol `packages/ai`](https://github.com/Effect-TS/effect-smol/tree/main/packages/ai)
- [Cohere Embed API](https://docs.cohere.com/reference/embed)
- [Cohere multimodal embeddings](https://docs.cohere.com/docs/multimodal-embeddings)
- [Voyage embeddings](https://docs.voyageai.com/reference/embeddings-api)
- [Voyage multimodal](https://docs.voyageai.com/reference/multimodal-embeddings-api)
- [Jina v4 embeddings](https://jina.ai/embeddings/)
- [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings)
- [Vertex multimodal](https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-multimodal-embeddings)
- [Mixedbread embeddings](https://www.mixedbread.com/docs/inference/embedding)
- [OpenAI new embedding models](https://openai.com/index/new-embedding-models-and-api-updates/)
