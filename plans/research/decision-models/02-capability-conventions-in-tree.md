> Research transcript, saved verbatim as a reference record. Produced by a
> research subagent on 2026-09-18 and kept unedited (including its own caveats
> and its em-dash punctuation) so the findings and their hedges stay intact.
> Prose authored by us follows house style; this file does not.

# How `effect-uai` defines a capability — structural reference

Repo root: `/Users/janschulte/code/effect-uai`. All paths absolute. Read-only survey; nothing modified.

---

## 1. Core capability service files

### 1.1 The invariant shape

Every cross-provider capability in `packages/core/src/<kebab-dir>/<PascalName>.ts` is built from exactly these parts, in this order:

1. **File-level doc comment** on the `Common…Request` type stating the seam: "Vendor knobs live on the provider's typed request."
2. **`Common<Verb><Noun>Request`** — a plain `readonly` object `type` (never an `interface`, never a `Schema`). Always carries `readonly model: string` with the comment _"Each provider narrows this to its typed literal union."_
3. **Result / usage / response types** — `<X>Result`, `<X>Usage` (all fields optional), `<X>Response`.
4. **`<Name>Service`** — a `type` (object of function fields), each returning `Effect.Effect<Response, AiError.AiError>` (no `R`) or `Stream.Stream<Event, AiError.AiError>`.
5. **`class <Name> extends Context.Service<<Name>, <Name>Service>()("@betalyra/effect-uai/<Name>")`**.
6. **Optional phantom capability markers** — `Context.Service<X, void>` with tag `"@betalyra/effect-uai/capability/<Marker>"`.
7. **Free-function accessors** — one per service method, `Effect.flatMap(Tag, (s) => s.method(request))`, returning `Effect<…, AiError.AiError, Tag>`.

### 1.2 Exact tag-string convention

| Tag                 | Declaration site                                                    | Tag string                                 |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `Reranker`          | `packages/core/src/reranker/Reranker.ts:43-45`                      | `"@betalyra/effect-uai/Reranker"`          |
| `EmbeddingModel`    | `packages/core/src/embedding-model/EmbeddingModel.ts:103-105`       | `"@betalyra/effect-uai/EmbeddingModel"`    |
| `Transcriber`       | `packages/core/src/transcriber/Transcriber.ts:69-71`                | `"@betalyra/effect-uai/Transcriber"`       |
| `SpeechSynthesizer` | `packages/core/src/speech-synthesizer/SpeechSynthesizer.ts:136-139` | `"@betalyra/effect-uai/SpeechSynthesizer"` |
| `MusicGenerator`    | `packages/core/src/music-generator/MusicGenerator.ts:75-77`         | `"@betalyra/effect-uai/MusicGenerator"`    |
| `ImageGenerator`    | `packages/core/src/image-generator/ImageGenerator.ts:116-118`       | `"@betalyra/effect-uai/ImageGenerator"`    |
| `LanguageModel`     | `packages/core/src/language-model/LanguageModel.ts:58-60`           | `"@betalyra/effect-uai/LanguageModel"`     |
| `WebSearch`         | `packages/core/src/web-search/WebSearch.ts:142-144`                 | `"@betalyra/effect-uai/WebSearch"`         |
| `Chunker`           | `packages/core/src/chunker/Chunker.ts:26-28`                        | `"@betalyra/effect-uai/Chunker"`           |

Markers use a `/capability/` infix:

- `SttStreaming` — `packages/core/src/transcriber/Transcriber.ts:83-85` → `"@betalyra/effect-uai/capability/SttStreaming"`
- `TtsIncrementalText` — `packages/core/src/speech-synthesizer/SpeechSynthesizer.ts:151-153`
- `MultiSpeakerTts` — `packages/core/src/speech-synthesizer/SpeechSynthesizer.ts:164-166`
- `MusicInteractiveSession` — `packages/core/src/music-generator/MusicGenerator.ts:89-91`
- `ImageStreaming` — `packages/core/src/image-generator/ImageGenerator.ts:127-129`
- `RealtimeVideoInput` — `packages/core/src/realtime/RealtimeSession.ts:44`
- `Sandbox*` family — `packages/core/src/sandbox/Sandbox.ts:419-508` (10 markers)

Provider-typed tags use a `providers/<vendor>/` infix:

- `"@betalyra/effect-uai/providers/jina/JinaReranker"` — `packages/providers/jina/src/JinaReranker.ts:43-45`
- `"@betalyra/effect-uai/providers/google/GeminiEmbedding"` — `packages/providers/google/src/GeminiEmbedding.ts:75-77`

### 1.3 Request/response naming table

| Capability        | Request types                                                                                                                                                  | Response types                                                                 | Usage type               | Usage location                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------ |
| Reranker          | `CommonRerankRequest` (`Reranker.ts:8-15`)                                                                                                                     | `RerankResult` (`:17-21`), `RerankResponse` (`:34-37`)                         | `RerankUsage` (`:24-26`) | same file                                                          |
| EmbeddingModel    | `CommonEmbedRequest` (`EmbeddingModel.ts:38-65`), `CommonEmbedManyRequest` (`:72-74`)                                                                          | `EmbedResponse<E>` (`:83-86`), `EmbedManyResponse<E>` (`:89-92`)               | `Usage`                  | **`embedding-model/Embedding.ts:149-151`**                         |
| Transcriber       | `CommonTranscribeRequest` (`Transcriber.ts:12-27`), `CommonStreamTranscribeRequest` (`:36-40`)                                                                 | `TranscriptResult`, `TranscriptEvent`                                          | inside `Transcript`      | **`domain/Transcript.ts`**                                         |
| SpeechSynthesizer | `CommonSynthesizeRequest` (`:29-50`), `CommonStreamSynthesizeRequest` (`:61`), `CommonSynthesizeDialogueRequest` (`:80-86`)                                    | `AudioBlob`, `AudioChunk`                                                      | n/a                      | **`domain/Audio.ts`**                                              |
| MusicGenerator    | `CommonGenerateMusicRequest`, `CommonStreamGenerateMusicRequest`                                                                                               | `GenerateResult`, `MusicStreamEvent`                                           | n/a                      | **`domain/Music.ts`** (re-exported from `MusicGenerator.ts:12-23`) |
| ImageGenerator    | `CommonImageGenerateRequest` (`:20-28`), `CommonImageEditRequest` (`:36-38`), `CommonStreamImageRequest` (`:41-43`), `CommonStreamImageEditRequest` (`:46-48`) | `ImageResponse` (`:57-66`), `ImageStreamEvent` (`:73-92`, a `Data.TaggedEnum`) | `ImageUsage` (`:51-55`)  | same file                                                          |
| LanguageModel     | `CommonRequest` (`:14-42`) — note: no `Common…Request` prefix, it is the original                                                                              | `Turn`, `TurnEvent`                                                            | `Items.Usage`            | **`domain/Turn.ts` / `domain/Items.ts`**                           |

**Rule of thumb visible in the tree:** small capabilities keep everything in the one service file (Reranker, ImageGenerator, WebSearch, Chunker). Capabilities whose value types are shared with other capabilities push them into `packages/core/src/domain/*.ts` (`Audio`, `Music`, `Transcript`, `Image`, `Items`, `Turn`) or a sibling file (`embedding-model/Embedding.ts`), then re-export type-only from the service module.

### 1.4 Free-function accessor convention

- Effect-returning: `Effect.flatMap(Tag, (s) => s.method(request))` — `Reranker.ts:48-51`, `EmbeddingModel.ts:108-117`, `ImageGenerator.ts:132-141`, `LanguageModel.ts:76-77`, `WebSearch.ts:158-161`, `Chunker.ts:31-34`.
- Stream-returning, no marker: `Stream.unwrap(Effect.map(Tag, (s) => s.method(request)))` — `LanguageModel.ts:65-68`, `SpeechSynthesizer.ts:175-178`, `MusicGenerator.ts:100-103`.
- Stream-returning **with** marker: `Stream.unwrap(Effect.gen(function* () { const s = yield* Tag; yield* Marker; return s.method(req) }))` — `ImageGenerator.ts:144-153`, `:156-165`.
- Stream transformer taking a source stream: `Function.dual(2, …)` giving both pipeable and direct arity, with the marker in `R` — `Transcriber.ts:110-130`, `SpeechSynthesizer.ts:193-213`, `MusicGenerator.ts:129-164`.
- Effect-returning with marker: `Effect.gen` that yields the marker then delegates — `SpeechSynthesizer.ts:219-226`.
- Extra helper shapes co-located in the service file: `EmbeddingModel.assertEncoding` (`EmbeddingModel.ts:131-144`), `LanguageModel.turnFromStream` (`LanguageModel.ts:85-98`).

### 1.5 How provider-specific knobs are kept out of the Common request

Four mechanisms, all documented in `plans/capabilities.md`:

1. **Type-level narrowing on the provider's own request** — `Omit<CommonXRequest, "model" | …> & { model: <Vendor>Model; … }`. E.g. `packages/providers/jina/src/JinaReranker.ts:29-32` (narrows `model`, widens `documents` to multimodal); `packages/providers/google/src/GeminiEmbedding.ts:43-57` (narrows `model`, widens `task` from `"query" | "document"` to the 8-value Google enum, adds `title`).
2. **Phantom capability markers** in `R` (§1.2) — compile-time gating. Policy: `plans/capabilities.md:185-222`, naming rule `:353-367`, curated list `:476-535`. **Note `plans/capabilities.md:521`: "Reranker: lax-only, no markers (no candidates pass the bar)."**
3. **Runtime `AiError.Unsupported`** for "bucket 1" gaps (dropping the field would structurally break the output). Example helper: `EmbeddingModel.assertEncoding` (`EmbeddingModel.ts:131-144`); example blanket stub: `packages/providers/mistral/src/MistralTranscriber.ts:174-190`.
4. **`warnDropped` / `CapabilityWarning`** for "bucket 2" gaps (provider has no place for the hint, output still valid) — `packages/core/src/capabilities/Capabilities.ts:17-28` (the event type), `:53-54` (`warnDropped`), `:79-82` (`warnDroppedWhen`), `:106-119` (`warnDroppedBlocks`).

### 1.6 Smallest representative example, in full

`/Users/janschulte/code/effect-uai/packages/core/src/reranker/Reranker.ts` (52 lines, the whole capability — this is the model to copy):

```ts
import { Context, Effect } from "effect"
import type * as AiError from "../domain/AiError.js"

/**
 * Cross-provider rerank request. Vendor knobs (multimodal documents,
 * instruction fields, truncation) live on the provider's typed request.
 */
export type CommonRerankRequest = {
  readonly query: string
  readonly documents: ReadonlyArray<string>
  /** Each provider narrows this to its typed literal union. */
  readonly model: string
  /** Keep only the top N results. Default: all documents. */
  readonly topN?: number
}

export type RerankResult = {
  /** Position in the request's `documents`. */
  readonly index: number
  readonly score: number
}

/** Optional throughout: some providers bill per search unit, not per token. */
export type RerankUsage = {
  readonly totalTokens?: number
}

/**
 * Score contract: `results` is sorted descending, higher is better. Scores
 * order candidates within one call; no range or calibration is promised and
 * they are not comparable across requests. Implementors must sort descending
 * if the wire does not.
 */
export type RerankResponse = {
  readonly results: ReadonlyArray<RerankResult>
  readonly usage: RerankUsage
}

export type RerankerService = {
  readonly rerank: (request: CommonRerankRequest) => Effect.Effect<RerankResponse, AiError.AiError>
}

export class Reranker extends Context.Service<Reranker, RerankerService>()(
  "@betalyra/effect-uai/Reranker",
) {}

/** Score a candidate set against a query, best first. */
export const rerank = (
  request: CommonRerankRequest,
): Effect.Effect<RerankResponse, AiError.AiError, Reranker> =>
  Effect.flatMap(Reranker, (r) => r.rerank(request))
```

Note the house style visible here: import `AiError` as `import type * as AiError` when only types are needed (Reranker, ImageGenerator); as `import * as AiError` when a constructor is used (`EmbeddingModel.ts:2`, `Transcriber.ts:2`, `LanguageModel.ts:2`). Relative imports always carry the `.js` extension.

---

## 2. `AiError` — every variant and its fields

`/Users/janschulte/code/effect-uai/packages/core/src/domain/AiError.ts` (152 lines). All are `Data.TaggedError`, tag == class name (no namespace prefix). Every variant except `Cancelled`/`Unsupported`/`IncompleteTurn` carries a required `raw: unknown`.

| Line       | Variant                 | Fields                                                                                                                                                                                                          |
| ---------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:3`       | `type Scope`            | `"rpm" \| "tpm" \| "rpd" \| "tpd"`                                                                                                                                                                              |
| `:5-11`    | `RateLimited`           | `provider: string`, `retryAfter?: Duration.Duration`, `scope?: Scope`, `requestId?: string`, `raw: unknown`                                                                                                     |
| `:13-19`   | `Unavailable`           | `provider`, `retryAfter?: Duration.Duration`, `status?: number`, `requestId?: string`, `raw`                                                                                                                    |
| `:21-25`   | `Timeout`               | `provider`, `requestId?`, `raw`                                                                                                                                                                                 |
| `:27-32`   | `ContentFiltered`       | `provider`, `reason?: string`, `requestId?`, `raw`                                                                                                                                                              |
| `:34-39`   | `ContextLengthExceeded` | `provider`, `modelLimit?: number`, `requested?: number`, `raw`                                                                                                                                                  |
| `:41-46`   | `InvalidRequest`        | `provider`, `param?: string`, `requestId?`, `raw`                                                                                                                                                               |
| `:48`      | `type AuthSubtype`      | `"auth" \| "permission" \| "billing" \| "quota"`                                                                                                                                                                |
| `:50-54`   | `AuthFailed`            | `provider`, `subtype: AuthSubtype` (**required**), `raw`                                                                                                                                                        |
| `:56-58`   | `Cancelled`             | `provider` only                                                                                                                                                                                                 |
| `:66-72`   | `GenerationFailed`      | `provider`, `code?: string`, `message?: string`, `requestId?`, `raw`                                                                                                                                            |
| `:79-81`   | `IncompleteTurn`        | `raw?: unknown` only (no `provider`)                                                                                                                                                                            |
| `:97-101`  | `Unsupported`           | `provider`, `capability: string`, `reason?: string` (no `raw`)                                                                                                                                                  |
| `:107-110` | `SessionExpired`        | `provider`, `raw?: unknown`                                                                                                                                                                                     |
| `:112-124` | `type AiError`          | the 12-arm union                                                                                                                                                                                                |
| `:126-127` | `withReason`            | private helper                                                                                                                                                                                                  |
| `:133-151` | `describe`              | `Match.type<AiError>().pipe(Match.discriminatorsExhaustive("_tag")({…}))` — one prose line per variant. **Adding a variant requires adding an arm here** (the `Exhaustive` matcher will not compile otherwise). |

Doc comments worth reading for placement policy: `:60-65` (`GenerationFailed` vs `Unavailable` vs `IncompleteTurn`), `:83-96` (`Unsupported` is for _request-data-dependent_ gaps; blanket provider gaps are gated at compile time via markers), `:103-106` (`SessionExpired`).

---

## 3. Provider implementation pattern (non-language-model capabilities)

### 3.1 Directory layout / file naming

`packages/providers/<vendor>/`:

```
CHANGELOG.md
README.md            (jina has none; google/mistral do)
LICENSE              (google only; required by RELEASING.md step 3)
package.json
tsconfig.json        { "extends": "../../../tsconfig.base.json", "include": ["src/**/*"] }
tsdown.config.ts     identical in every package (entry src/**/*.ts, esm, dts+sourcemap, target es2022, outDir dist)
src/
  index.ts           `export * as <Name> from "./<Name>.js"` per capability + `export * from "./models.js"`
  models.ts          typed model-id literal unions with a `(string & {})` tail
  <Vendor><Capability>.ts   one file per capability, PascalCase, exports `make` + `layer` + typed tag
  codec.ts / http.ts / region.ts / realtimeStt.ts   shared internals, lowerCamelCase
  *.test.ts          co-located, vitest
```

Verified inventories:

- `packages/providers/jina/src/` → `JinaEmbedding.ts` (562L), `JinaReader.ts`, `JinaReranker.ts` (203L), `index.ts` (4L), `models.ts` (56L). **No test files at all.**
- `packages/providers/google/src/` → `Gemini.ts`, `GeminiEmbedding.ts` (362L), `GeminiImageGenerator.ts`, `GeminiLiveSession.ts`, `GeminiSynthesizer.ts` + `.test.ts`, `GeminiTools.ts`, `GoogleDeepResearch.ts` + `.test.ts`, `LyriaGenerator.ts` + `.test.ts`, `codec.ts`, `geminiSpeechCodec.ts` + `.test.ts`, `geminiTools.test.ts`, `realtimeSession.ts` + `.test.ts`, `index.ts`, `models.ts`.
- `packages/providers/mistral/src/` → `Mistral.ts`, `MistralTranscriber.ts` (222L), `MistralRealtimeTranscriber.ts`, `MistralSynthesizer.ts`, `audioCodec.ts`, `codec.ts` + `codec.test.ts`, `http.ts` (56L), `realtimeStt.ts`, `onHalt.test.ts`, `index.ts`, `models.ts`.
- `packages/providers/elevenlabs/src/` → `ElevenLabsMusicGenerator.ts` (350L) + `.test.ts` (116L), `ElevenLabsSynthesizer.ts`, `ElevenLabsTranscriber.ts` + `.test.ts`, `codec.ts` + `.test.ts`, `musicCodec.ts`, `realtimeStt.ts`, `realtimeTts.ts`, `region.ts` + `.test.ts`, `index.ts`, `models.ts`.

### 3.2 Canonical file structure inside a provider capability module

`packages/providers/jina/src/JinaReranker.ts` is the reference (203 lines), with `// ---` banner comments delimiting exactly these sections:

| Lines     | Section                   | Content                                                                                                                                                                                                                                                                              |
| --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `1-12`    | imports                   | `effect` first, then `effect/unstable/http`, then `@effect-uai/core/*` subpaths, then relative `./models.js`                                                                                                                                                                         |
| `14-50`   | `// Public types`         | `JinaRerankDocument` (`:23-27`), `JinaRerankRequest` (`:29-32`), `JinaRerankerService` (`:34-36`), `class JinaReranker` (`:43-45`), `export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }` (`:47-50`)                                              |
| `52-88`   | `// Codec - request body` | private `WireDocument` type (`:56`), `Match.type<…>().pipe(Match.tag(…), Match.exhaustive)` converters (`:59-72`), `WireBody` (`:74-79`), `buildBody` (`:83-88`)                                                                                                                     |
| `90-120`  | `// Codec - response`     | **`Schema.Struct`** wire schemas: `WireResult` (`:94-97`), `WireUsage` (`:99-102`), `WireResponse` (`:104-109`), each with a `type X = typeof X.Type` companion; `usageOf` (`:111-112`); `toResponse` (`:115-120`) which **sorts descending** because the score contract promises it |
| `122-170` | `// HTTP`                 | `transportFailure` (`:126-127`), `httpStatusError` (`:129-140`), `baseUrl` (`:142`), `postRerank` (`:144-163`), `rerankImpl` (`:165-170`)                                                                                                                                            |
| `172-203` | `// Constructors`         | `make(cfg)` (`:180-186`), `layer(cfg)` (`:194-203`)                                                                                                                                                                                                                                  |

### 3.3 HTTP client wiring

Uniform across all providers:

- `import { HttpClient, HttpClientRequest } from "effect/unstable/http"`.
- The `R` channel of `make` / `layer` is `HttpClient.HttpClient` — the layer **never** provides it. Callers add `FetchHttpClient.layer` (docs example: `docs/reranking/index.md:39`).
- Request build: `HttpClientRequest.post(url).pipe(HttpClientRequest.bearerToken(cfg.apiKey), HttpClientRequest.bodyJsonUnsafe(body))` — `JinaReranker.ts:150-153`. Google instead uses a header: `HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey))` — `GeminiEmbedding.ts:255`. Mistral multipart: `bodyMultipart` via `@effect-uai/core/Multipart` — `mistral/src/http.ts:51-56`, used at `MistralTranscriber.ts:155-159`.
- `client.execute(req).pipe(Effect.mapError(transportFailure))`, then `if (response.status >= 400) { const text = yield* response.text.pipe(Effect.orElseSucceed(() => "")); return yield* httpStatusError(status, text) }`, then `response.json.pipe(Effect.mapError(transportFailure))`, then `Schema.decodeUnknownEffect(WireResponse)(json).pipe(Effect.mapError(transportFailure))` — `JinaReranker.ts:148-163`, `GeminiEmbedding.ts:247-270`, `MistralTranscriber.ts:152-168`.
- `make` closes over the resolved client and re-provides it per call so the service type has `R = never`: `Effect.map(HttpClient.HttpClient, (client) => ({ method: (req) => impl(cfg)(req).pipe(Effect.provideService(HttpClient.HttpClient, client)) }))` — `JinaReranker.ts:180-186`, `GeminiEmbedding.ts:319-327`, `MistralTranscriber.ts:196-204`.

### 3.4 Status → `AiError` mapping (the house table)

Identical status table in every provider, spelled two ways:

- if-chain: `JinaReranker.ts:129-140`, `GeminiEmbedding.ts:227-238` — 429→`RateLimited`, 408/504→`Timeout`, 401→`AuthFailed{auth}`, 403→`AuthFailed{permission}`, 402→`AuthFailed{billing}`, 413→`ContextLengthExceeded`, ≥500→`Unavailable{status}`, else→`InvalidRequest`.
- `Match.value(status).pipe(Match.when…, Match.whenOr…, Match.orElse…)` in a shared `http.ts`: `packages/providers/mistral/src/http.ts:7-45`. Transport failures always → `Unavailable{provider, raw: cause}` (`http.ts:47-48`).

### 3.5 Config / API keys

**Providers never read `Config` themselves.** Every provider exports

```ts
export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}
```

(`JinaReranker.ts:47-50`, `GeminiEmbedding.ts:79-82`; 41 occurrences of `readonly apiKey: Redacted.Redacted` across `packages/providers`). `Config.redacted(...)` is called by the _caller_ — every hit is in `recipes/**` or docs, zero in `packages/**`: e.g. `recipes/_shared/model.ts:114-115`, `recipes/model-council/app.ts:51-53`, `docs/reranking/index.md:32-39` (`Layer.unwrap(Effect.gen(function* () { const apiKey = yield* Config.redacted("JINA_API_KEY"); return jinaRerankerLayer({ apiKey }) }))`).

### 3.6 Typed request narrowing the Common request

- `JinaRerankRequest = Omit<CommonRerankRequest, "model" | "documents"> & { model: JinaRerankerModel; documents: ReadonlyArray<JinaRerankDocument> }` — `JinaReranker.ts:29-32`.
- `GeminiEmbedRequest = Omit<CommonEmbedRequest, "model" | "task" | "encoding"> & { model: GoogleEmbeddingModel; task?: GoogleEmbeddingTask; title?: string }` — `GeminiEmbedding.ts:43-57`; batch variant `Omit<GeminiEmbedRequest, "input"> & { inputs }` at `:59-61`.
- `models.ts` typed unions always end with `| (string & {})` plus an eslint-disable, so newly released models work without an SDK bump — `packages/providers/jina/src/models.ts:20-27` (`JinaEmbeddingModel`), `:39-44` (`JinaRerankerModel`), `:51-56` (`JinaEngine`).

### 3.7 The `layer` dual-registration pattern (most important bit)

```ts
export const layer = (
  cfg: Config,
): Layer.Layer<JinaReranker | Reranker, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(JinaReranker, make(cfg))
  const generic = Layer.effect(
    Reranker,
    Effect.map(make(cfg), (s): RerankerService => ({ rerank: (request) => s.rerank(request) })),
  )
  return Layer.merge(typed, generic)
}
```

— `packages/providers/jina/src/JinaReranker.ts:194-203`. One implementation, two tags. Variants:

- With a guard on the generic path: `GeminiEmbedding.ts:334-362` wraps each method in `assertEncoding(req.encoding, ["float32"], "gemini")` and casts `req as GeminiEmbedRequest`; the inline comment at `:341-346` explains why `task` is left silent (per `capabilities.md §2.3`, no per-model tables).
- With a cast on the generic path: `MistralTranscriber.ts:205-222` — `transcribe: (req: CommonTranscribeRequest) => s.transcribe(req as MistralTranscribeRequest)`.
- With markers: `Layer.mergeAll(typed, generic, Layer.succeed(Marker, undefined))` — described in `plans/realtime.md:56-59`; the sync-only Mistral layer deliberately omits `SttStreaming` (`MistralTranscriber.ts:200-204` + the `streamUnsupported` stub at `:174-190`).

### 3.8 Test file layout and what tests assert

Provider tests are `src/<Module>.test.ts`, plain `vitest` (`describe`/`it`/`expect`/`expectTypeOf`), **no HTTP**. Reference: `packages/providers/elevenlabs/src/ElevenLabsMusicGenerator.test.ts` (116 lines), three `describe` blocks:

1. `"… capability guards (runtime)"` (`:13-30`) — calls the un-wired stream method through `Tag.use(...)`, asserts `exit._tag === "Failure"` and `JSON.stringify(exit.cause)` contains `"Unsupported"` and the method name.
2. `"… Layer (compile-time)"` (`:32-73`) — `expectTypeOf(provided).toEqualTypeOf<Effect.Effect<void, AiError.AiError, MusicGenerator.MusicInteractiveSession>>()` proves the marker is _unsatisfied_; a second case proves the non-gated method clears `R` to `never`; a third constructs a provider-typed request literal to prove the extra fields typecheck.
3. `"… codec validation (runtime, no HTTP)"` (`:75-116`) — mutually-exclusive field combinations produce `InvalidRequest` with a specific message substring.

Layer under test is built with a fake key: `const cfg = { apiKey: Redacted.make("test-key") }`; `const live = Layer.provide(X.layer(cfg), FetchHttpClient.layer)` (`:10-11`).

Core-side capability tests: `packages/core/src/embedding-model/EmbeddingModel.test.ts` (108 lines) is **type-level only** (`expectTypeOf`, plus `@ts-expect-error` cases at `:87-90` and an `@effect-diagnostics effect/floatingEffect:off` escape at `:86`). `packages/core/src/transcriber/Transcriber.test.ts` and `music-generator/MusicGenerator.test.ts` mix scripted-mock runtime assertions with compile-time marker assertions ("a sync-only layer leaves `SttStreaming` unsatisfied in R", "a full layer (with marker) clears R to never"). Mocks live in `packages/core/src/testing/`: `MockProvider.ts`, `MockTranscriber.ts`, `MockSpeechSynthesizer.ts`, `MockMusicGenerator.ts`, `MockRealtimeSession.ts`, `MockMessenger.ts`, `MockSandbox.ts`, `FakeWebSocket.ts` — **there is no `MockReranker.ts` or `MockEmbeddingModel.ts`**; those are stubbed inline with `Layer.succeed` in the consuming test (`recipes/retrieve-and-rerank/recipe.test.ts:26-45`). Mock convention: a `Mock…Script` type, a `Mock…Recorder`, `Ref`-based call cursors, and an `InvalidRequest{provider:"mock"}` when the script is exhausted (`MockTranscriber.ts:14-60`).

---

## 4. Package layout & registration

### 4.1 `pnpm-workspace.yaml`

`/Users/janschulte/code/effect-uai/pnpm-workspace.yaml` (44 lines):

- globs: `packages/*`, `packages/providers/*`, `packages/compat/*`, `recipes`, `webpage`, `integration-tests/*`; two `!`-exclusions for the heavy native sandbox integration tests.
- `allowBuilds: { esbuild, msgpackr-extract, sharp }`.
- `catalog:` — `@effect/language-service ^0.87.2`, `@effect/platform-bun/node/vitest 4.0.0-rc.111`, `@types/node ^26.2.0`, `@types/ws ^8.5.13`, `effect 4.0.0-rc.111`, `tsx ^4.23.12`, `typescript ^7.0.2`, `vitest ^4.1.11`, `ws ^8.18.0`.
- `catalogs.peer` — `effect: ">=4.0.0-rc.111 <5.0.0"`, `ws: ^8.0.0`. `catalogs.astro` — `typescript: ^6.0.3` (astro-check can't handle TS 7).

### 4.2 Provider `package.json` shape

`packages/providers/jina/package.json` (67 lines) is the template: `name: "@effect-uai/jina"`, `version: "0.16.0"` (every publishable package shares one version), `description`, alphabetized `keywords`, `homepage` pointing at the subdirectory, `bugs`, `license: MIT`, `author: Betalyra`, `repository` with `directory`, `files: ["dist","src","README.md","LICENSE"]`, `type: module`, `main: ./dist/index.mjs`, `types: ./dist/index.d.mts`, `exports` with a `"."` entry **plus one subpath per capability module** (`./JinaEmbedding`, `./JinaReader`, `./JinaReranker` → `dist/<Name>.d.mts` / `.mjs`), `publishConfig.access: public`, `scripts: { build: "tsdown", typecheck: "tsc --noEmit" }`, `devDependencies: { "@effect-uai/core": "workspace:*", effect: "catalog:", typescript: "catalog:" }`, `peerDependencies: { "@effect-uai/core": "workspace:>=0.2.0 <1", effect: "catalog:peer" }`.

`packages/core/package.json`: same head, `exports` has ~60 flat subpaths mapping a public name to its nested dist path — e.g. `"./AiError" → ./dist/domain/AiError.mjs` (`:37-40`), `"./Reranker" → ./dist/reranker/Reranker.mjs` (`:141-143`), `"./EmbeddingModel" → ./dist/embedding-model/EmbeddingModel.mjs` (`:113-116`), plus `"./testing/Mock*"` entries (`:265-292`). Only runtime dep: `@standard-schema/spec ^1.1.0`.

**Adding a core capability therefore touches exactly three places in core:** the new `src/<dir>/<Name>.ts`, a line in `packages/core/src/index.ts` (58 lines, `export * as <Name> from "./<dir>/<Name>.js"`, roughly alphabetical — `Reranker` at `:28`, `EmbeddingModel` at `:21`), and a `"./<Name>"` subpath in `packages/core/package.json`. `plans/realtime.md:35-40` states this three-step rule explicitly.

### 4.3 Registering a new package

`RELEASING.md` (`## Adding a new package`, `:46-96`) — six required steps:

1. add the name to the `fixed` group in `.changeset/config.json` (currently 25 names; `ignore: ["@effect-uai/recipes", "@effect-uai/recipe-kit"]`);
2. set the `peerDependencies` floor to the version the package debuts at and never bump it;
3. metadata check (no `private: true`, `publishConfig.access: public`, `files` lists `dist src README.md LICENSE`, those files exist, a `build` script exists because `pnpm build` filters on `@effect-uai/*`);
4. write a changeset;
5. bootstrap-publish manually to claim the npm name;
6. configure trusted publishing on npmjs.com.
   Plus `:98-114` on why the bootstrap version is usually broken and how to deprecate it.

Other registration surfaces: `/Users/janschulte/code/effect-uai/tsconfig.json` has `references` for only 6 packages + `recipes` (core, responses, google, anthropic, jina, deno) — it is a partial project-reference graph used by `pnpm lint:effect`. Root `package.json:27-45` scripts: `test` (`vitest run` from the root `vitest.config.ts`), `typecheck` (`pnpm -r typecheck`), `build` (`pnpm --filter "@effect-uai/*" -r build`), `format` (`oxfmt`), `lint:effect` (`effect-language-service diagnostics`).

### 4.4 `packages/effect-uai` — the umbrella

`packages/effect-uai/package.json` is **18 lines and re-exports nothing**: `"description": "Reserved name. See @effect-uai/core and the @effect-uai/* provider packages."`, no `exports`, no `main`, no `files`, `scripts.typecheck: "echo 'no-op'"`. Contents of the directory: `CHANGELOG.md`, `README.md`, `package.json` — no `src/`. It exists solely to hold the npm name at the shared version.

### 4.5 `packages/compat/ai-sdk`

`@effect-uai/ai-sdk` v0.16.0 — "Vercel AI SDK (useChat) UI Message Stream compatibility for @effect-uai/core." Files: `src/Messages.ts`, `src/UIMessageStream.ts` + `UIMessageStream.test.ts`, `src/conformance.test.ts`, `src/index.ts`. Exports `"."`, `"./UIMessageStream"`, `"./Messages"`. Same metadata template as a provider.

### 4.6 `packages/recipe-kit`

`@effect-uai/recipe-kit` v0.0.0, **`private: true`, not published**, `changeset` `ignore`d. Exports point straight at TypeScript source (`"./argv": "./src/argv.ts"`, plus `./bundle`, `./inline-image`, `./output`, `./render`, `./runtime`). Deps: `@effect-uai/core`, `@effect/platform-bun|node|deno`, `effect`, `rolldown`. `src/runtime.ts` provides `runRecipe` / `serveRecipe` which pick the platform layers per runtime.

### 4.7 `packages/retrieval`

`@effect-uai/retrieval` v0.16.0 — "Retrieval-pipeline utilities for @effect-uai/core: text chunking, rank fusion, and a Hugging Face tokenizer layer." Files: `src/Chunking.ts` + `.test.ts`, `src/HuggingFaceTokenizer.ts`, `src/Rank.ts` + `Rank.test.ts`, `src/index.ts`. Exports `"."`, `"./Chunking"`, `"./Rank"`, `"./HuggingFaceTokenizer"`. Notable: `@huggingface/tokenizers` is an **optional** peer (`peerDependenciesMeta`), peer floor `@effect-uai/core workspace:>=0.12.0 <1`.

**`packages/retrieval/src/Rank.ts` (38 lines) — reciprocal rank fusion, and the precedent for "a capability-adjacent concept that is a plain function, not a service":**

- `:1-5` file doc: "Rank fusion: merge several ranked lists of the same items into one ranking by position, so retrievers on incomparable score scales (BM25, cosine) can be combined without normalizing them."
- `:8-11` `export type Fused<A> = { readonly value: A; readonly score: number }`.
- `:13` `byScore = Order.mapInput(Order.flip(Order.Number), (f) => f.score)`.
- `:23-38` `export const rrf = <A>(rankings: ReadonlyArray<ReadonlyArray<A>>, options?: { k?: number; weights?: ReadonlyArray<number> }): Array<Fused<A>>` — `score(v) = Σ weightᵢ / (k + rankᵢ(v))`, `k` default 60, `Map`-keyed so callers fuse ids not fresh objects, sorted descending, ties keep first-seen order.
  `docs/retrieval/index.md:13-18` places it in the stage table as "Merge rankings that disagree | none, a function | `Rank.rrf`".

---

## 5. Docs — how a capability is documented

### 5.1 Mechanics

- Markdown lives in `/Users/janschulte/code/effect-uai/docs/` (a sibling of `webpage/`, not inside it). The Astro/Starlight site loads it via a glob loader: `webpage/src/content.config.ts:11-27` — `base: ".."`, `pattern: ["docs/**/*.{md,mdx}", "recipes/*/README.md", "recipes-extras/*/README.md"]`; `docs/x/index.md` → slug `x`; `recipes/<name>/README.md` → slug `recipes/<name>` (and `recipes-extras/<name>/README.md` maps to the same `recipes/` slug space).
- Frontmatter schema: `docsSchema({ extend: z.object({ source?, icon?, gallery? }) })` — `webpage/src/content.config.ts:26-52`. `title` + `description` come from Starlight's base schema; `icon` must be a `react-icons/pi` name registered in `webpage/src/components/PageTitle.astro`; `source` renders a "View on GitHub" chip; `gallery` renders a filmstrip.
- Sidebar registration is hand-written in `/Users/janschulte/code/effect-uai/webpage/astro.config.mjs`. A capability gets a top-level group with `Overview` → sub-pages → a `Providers` sub-group → a collapsed `Recipes` sub-group. Embeddings group: `:336-369`. Retrieval group (which owns Reranking): `:341-355` — `{ label: "Retrieval", items: [ {Overview, slug:"retrieval"}, {Chunking, slug:"retrieval/chunking"}, {Reranking, slug:"reranking"}, { label:"Recipes", collapsed:true, items:[retrieve-and-rerank, agentic-search, contextual-retrieval] } ] }`. Redirects for moved pages live at `:31-42`.
- `docs/` top-level dirs, one per capability: `browser coming-from embeddings image-generation language-models messenger migrations music-generation providers realtime recipes reranking retrieval sandboxes search speech start video-generation web-reading` + `index.mdx`, `intro.mdx`, `skills.md`.

### 5.2 The Reranker page

`/Users/janschulte/code/effect-uai/docs/reranking/index.md` — 143 lines, the only file in `docs/reranking/`. Structure:

- `:1-5` frontmatter: `title: Reranking`, a one-sentence `description`, `icon: PiStack`. (No `source`.)
- `:7-17` cold open in scenario form ("Your agent just searched and got back fifty candidates…"), then what the capability is for.
- `:19-23` `## Install` — one `pnpm add` line naming core + the provider + `effect`.
- `:25-43` `## Wire it up` — the `Layer.unwrap` + `Config.redacted` + `FetchHttpClient.layer` snippet, closing with "One layer, two tags".
- `:45-83` `## Rerank` — the call, then the _index-not-text_ caveat, then the `CommonRerankRequest` / `RerankResponse` interfaces copied verbatim as a code block, then `topN`.
- `:84-94` `## About the scores` — the contract restated (descending, uncalibrated, not comparable across calls), rank cutoffs travel / thresholds don't.
- `:96-122` `## Ranking images` — the provider-typed-tag escape hatch, with the `JinaReranker` snippet.
- `:124-132` `## What reranking is not` — three bullets, each linking the neighbouring capability.
- `:134-143` `## See also` — recipes first, then sibling capabilities.

### 5.3 The EmbeddingModel pages

`/Users/janschulte/code/effect-uai/docs/embeddings/` → `index.md`, `multimodal.md`, `multivector.md`, `providers/{gemini,jina,openai}.md`.

`docs/embeddings/index.md` — frontmatter `title: Embedding model`, `description`, `icon: PiGraph`; headings: `## The shape` (`:25`), `## Two top-level helpers` (`:53`), `## What you get back` (`:67`), `## Encoding and task` (`:91`), `## Multimodal input` (`:113`), `## Vector math` (`:132`), `## Portable vs. provider-specific` (`:154`), `## What `EmbeddingModel` is not` (`:190`), `## Layer registration` (`:199`), `## Next step` (`:218`), `## See also` (`:223`). `:25-33` quotes the `EmbeddingModelService` interface and the `Context.Service` line with `(...)` elided — the house way to show a tag in docs. `:16-17` explicitly says "This is the same seam the [language model](/language-models/) uses."

Provider page shape (`docs/embeddings/providers/jina.md`): frontmatter `title: "Jina (embeddings)"`, `description` only (no icon); headings `## Install`, `## Wire it up`, `## Request shape`, `## Calling it`, `## Models`, `## Encoding support`, `## Image input shapes`, `## Errors`, `## See also` (lines 16/22/48/74/122/139/154/166/184).

Also relevant: `skills/effect-uai/SKILL.md` is the agent-facing summary of the whole library (`## Design philosophy`, `## Install`, `## Core modules (cheat sheet)` at `:86`, `## Provider wiring` at `:123`, `## Recipe library` at `:306`, `## Common gotchas`, `## Testing`) — a new capability should be added to its cheat sheet.

---

## 6. Recipes

### 6.1 Layout

`/Users/janschulte/code/effect-uai/recipes/` — 50 recipe directories plus `README.md`, `_shared/model.ts`, `package.json`, `tsconfig.json`, `tsconfig.client.json`, `deno.json`, `output/`.

`recipes/README.md:11-23` states the contract verbatim:

| File        | What it holds                                                    |
| ----------- | ---------------------------------------------------------------- |
| `recipe.ts` | The effect-uai logic. **Names capability tags, never a vendor.** |
| `app.ts`    | Composition: flags, provider Layers, rendering, and `main`.      |
| `run.ts`    | One line. Same file on Node, Bun and Deno.                       |
| `README.md` | The scenario.                                                    |

"Plus `recipe.test.ts` where a recipe has stream or loop logic worth pinning down." Running: `pnpm tsx recipes/<name>/run.ts` / `bun …` / `deno run --allow-all …`. Shared plumbing = `@effect-uai/recipe-kit` (`runRecipe`/`serveRecipe`, `argv`, `output`); provider selection = `recipes/_shared/model.ts` — "one place that knows which package, base URL and env var each provider needs, so `--model provider:model` works across every capability."

`recipes/package.json`: `@effect-uai/recipes` v0.0.0, `private: true`, only script is `typecheck`, and it depends on **every** provider workspace package + `@effect-uai/recipe-kit` + `effect: catalog:`. A new provider package must be added here to be reachable from recipes.

`_shared/model.ts` is the per-capability layer registry: `embeddingModelLayer` (`:489-493`), `multivectorEmbeddingLayer` (`:506-513`), `rerankerLayer` (`:522-526`) over `rerankEntries` (`:515-519`, currently `{ jina: { layer: (apiKey, baseUrl) => jinaRerankerLayer({ apiKey, ...at(baseUrl) }), apiKey: key("JINA_API_KEY") } }`), `deepResearchLayer` (`:549-552`), etc. Each returns `Layer.Layer<Tag, Config.ConfigError | UnknownProvider, HttpClient.HttpClient>` built with `Layer.unwrap(registry(spec, baseUrl, entries))`. **A new capability adds one `…Entries` record + one `…Layer` function here.**

### 6.2 The Reranker/Embedding recipes

- `recipes/retrieve-and-rerank/` — `README.md`, `app.ts`, `corpus.ts`, `recipe.test.ts`, `recipe.ts`, `run.ts`.
- `recipes/basic-embedding/` — `README.md`, `app.ts`, `recipe.ts`, `run.ts`.
- `recipes/multimodal-embedding/`, `recipes/multivector-embedding/` — same shape.
- `recipes-extras/agentic-search/` and `recipes-extras/contextual-retrieval/` — install-isolated (they carry a libsql dep: `libsql.ts`), but map to the same `/recipes/<name>/` doc slug.

`recipes/retrieve-and-rerank/recipe.ts` (111 lines): file doc `:1-10` explains the recipe.ts/app.ts/run.ts split; imports only `@effect-uai/core/*` generic tags (`embed`, `embedMany`, `streamTurn`, `loop`, `rerank`, `Vector`) at `:11-17`; exports `Ranked`/`Retrieval`/`RetrieveConfig` types (`:20-39`), `retrieve` (`:48-80`), `answer` (`:98-110`). `:73` carries the load-bearing comment "`results[].index` addresses the candidate list we sent, not the corpus."

`recipes/retrieve-and-rerank/app.ts` (118 lines): a `Flags` type (`:22-31`), `readFlags` reading `Stdio.Stdio` args via `@effect-uai/recipe-kit/argv` (`:33-54`), rendering helpers using `@effect-uai/recipe-kit/render` (`cyan`, `dim`, `renderEvent`), and `export const main = Effect.gen(…).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))` (`:80-117`). Layers are provided per stage: `Effect.provide(Layer.merge(embeddingModelLayer(flags.embed), rerankerLayer(flags.rerank)))` at `:92`. Missing optional key is caught, not fatal: `Effect.catchTag("ConfigError", …)` at `:113-115`.

`recipes/retrieve-and-rerank/run.ts` (18 lines): a doc comment listing the three runtime invocations and the env vars, then `import { runRecipe } from "@effect-uai/recipe-kit/runtime"; import { main } from "./app.js"; runRecipe(main)`.

`recipes/retrieve-and-rerank/README.md` (113 lines) — frontmatter `title`, `description`, **`source: recipes/retrieve-and-rerank`**, `icon: PiRanking`; then a concrete scenario with real numbers (`0.006 behind` vs `0.47`), `## Two stages`, `## Say which side you are embedding`, `## Run it`, `## Point it at your own documents`, `## Scores are ranks, not probabilities`, `## See also`.

`recipes/retrieve-and-rerank/recipe.test.ts` (135 lines) — pure-`vitest`, no network. Stubs the capabilities inline: `Layer.succeed(EmbeddingModel, {…} as unknown as EmbeddingModelService)` with a one-cast comment explaining why (`:24-33`), and a `reversingReranker` `Layer.succeed(Reranker, { rerank: … })` whose scores are deliberately inverted "so any reordering has to come from the rerank" (`:35-45`). Five `it`s on `retrieve` assert candidate cut, reordering, that non-candidates can't be rescued, index→corpus-id mapping, and the `keep` cap; two `it`s on `answer` use `MockProvider.layerWithRecorder` and assert the rendered system prompt.

---

## 7. `plans/` — inventory and house style

### 7.1 Inventory

`/Users/janschulte/code/effect-uai/plans/` — 51 top-level `.md` files + 5 subdirectories.

Files: `browser.md capabilities-plan.md capabilities.md chirp-stt.md chunking.md contextual-retrieval.md cuttlekit-use-cases.md deep-research.md docs-gateways-and-openai-naming.md docs-layout.md docs-structure.md elevenlabs-music.md embedding-revamp.md embeddings.md errors.md hitl-and-streaming-tools.md image-generation.md llm-provider-redesign.md loop-ergonomics.md managed-agents.md mcp.md messenger.md metrics.md mistral.md music-revamp.md music.md openai-compatible-chat.md realtime.md recipe-media.md recipe-model-selector.md recipes.md responses-gaps.md responses-tier12.md responses.md sandbox.md search.md structured-outputs.md stt-revamp.md stt-tts-docs.md stt-tts-wire.md stt-tts.md tool-kinds-and-composition.md tool-refactoring.md tool-refactoring2.md tool-result.md tts-revamp.md usage-tracking.md use-case-new-implementation.md v0-13.md web-extract.md websocket.md`

Subdirectories: `browser/` (`hosted-providers.md`, `local-tooling.md`, `scraping-vendors.md`, `use-cases.md`), `sandbox/`, `research/` (19 files incl. `reranking.md`, `reranking-plan.md`, `rag-recipe.md`, `rag-recipe-plan.md`, `jina-mistral.md`, `chunking.md`, `repo-audit.md`, + `image-generation/`, `messenger/`, `realtime/` subdirs), `citation-model-research/` (`README.md` + `01-…`–`04-…`).

Most recent by mtime: `metrics.md` (Sep 15, 784L), `realtime.md` (Sep 13, 566L), `messenger.md` (Sep 10, 905L), `v0-13.md` / `recipe-media.md` / `image-generation.md` (Sep 6). Largest: `stt-tts-wire.md` 1791L, `deep-research.md` 1286L, `stt-tts.md` 1198L, `mcp.md` 960L, `capabilities.md` 957L.

Observed pairing convention: **a research report and a plan are separate files** — `plans/research/reranking.md` (findings) + `plans/research/reranking-plan.md` (the research brief: `## Prior findings (re-verify…)`, `## Questions the research must answer` with `### Q1…Q4`, `## Method`, `## Deliverable`, `## Out of scope`), then a top-level `plans/<topic>.md` as the implementation plan. Likewise `capabilities.md` (policy/inventory) + `capabilities-plan.md` (phased implementation).

### 7.2 House style — `plans/realtime.md` (566 lines, the best template for a new capability)

- `:1` `# Realtime speech-to-speech: design and implementation plan`.
- `:3-7` unlabelled preamble paragraph: what the doc is ("Handover document for v0.13 item 4"), where the research lives, **"this file wins on any conflict with them"**, and "Work proceeds strictly in the step order below; each step is a separate PR that builds, typechecks and tests green on its own."
- `:9-31` `## Principles` — bolded-lead bullets that are decisions, not aspirations: "**Explicit over convenient.**", "**Two providers or none.**", "**Current models only.**" (with the literal model ids), "**Don't unify what isn't unified.**", "**No new provider packages.**", "**House rules.**" (no em-dashes, sparse comments, `Match` over nested ternaries, one `Effect.tryPromise` per step, `pnpm`/`pnpx`, "Tests exercise the real decode path; no trivial tests", plus two literal WebSocket gotchas).
- `:33-169` `## Core design` — names the exact files to create/edit up front (`:35-40`: "Files: `packages/core/src/domain/Realtime.ts` (types), `packages/core/src/realtime/RealtimeSession.ts` (service, marker, helpers), `packages/core/src/testing/MockRealtimeSession.ts`. Export … from `packages/core/src/index.ts` and add `./Realtime` and `./RealtimeSession` subpaths to `packages/core/package.json`"), then **`:42-60` "Precedents this design follows (checked 2026-09-11)"** — a bulleted list of existing in-tree patterns with markdown links to exact files (`Sandbox.ts`/`Browser.ts` for scoped handles, `Turn.ts` for `Data.taggedEnum` with a warning that `Music.ts` uses lowercase hand-rolled tags and must not be copied, `Transcriber.ts` for the phantom marker, `OpenAIRealtimeTranscriber.ts` for the `make`/`layer` split, `AiError.ts` for errors). Then full TypeScript sketches of the types and service.
- `:170-187` `## Provider mapping (summary; wire detail in the research subreports)`.
- `:188-404` `## Steps` with `### Step 1…9`, each a self-contained PR. Each step is a bulleted checklist of concrete file edits, ending with a **"Done when:"** line. Step 2 (`:212-231`) is the core-capability step and is the exact shape a new capability plan wants — it names the types file, the service file, the `AiError` addition, the mock, the type-level tests, and the docs page.
- `:405-413` `## Postponed (not in v0.13)`; `:414-425` `## Open questions to settle during the build`; `:426-553` `## Review fixes (2026-09-13)` with `### R1…R8` — the plan is _amended in place_ after review rather than superseded.
- Level of detail: code sketches are full, compilable-looking TypeScript for the core types; wire detail is delegated to `plans/research/realtime/*`.

### 7.3 House style — `plans/metrics.md` (784 lines, design-proposal flavour)

- `:1` `# Streaming metrics. design proposal` (lowercase after a period — the house avoids colons/em-dashes in titles).
- `:3-14` `Status: draft / for discussion.` then `Scope:` paragraph, with markdown links to the sibling plan (`usage-tracking.md`) and to the source file it reuses (`../packages/core/src/domain/Items.ts`).
- `:16-49` `## 1. The problem` — numbered gaps against the current file, with a bolded lead per gap, then "Two consumers want this data and they are not the same consumer".
- `:50-83` `## 2. Two layers` — an **ASCII box diagram** (`:52-67`) then bolded-lead bullets per layer.
- `:84-437` `## 3. Layer 1: measurement (`observability/Metrics.ts`)` with `### 3.1`–`### 3.6` and even `#### 3.3.1`. Heavy inline TypeScript sketches (`:94-100` shows the intended call-site pipeline).
- `:438-607` `## 4. Layer 2: export`, `:608-695` `## 5. Scope…` presented as `### Option A/B/C` with an explicit recommendation, `:696-714` `## 6. File layout`, `:715-…` `## 7. Testing`.
- Numbered sections throughout so other plans can cite `§3.2`. `plans/capabilities.md` does the same and is cited as `capabilities.md §2.3` from _source comments_ (`packages/providers/google/src/GeminiEmbedding.ts:345`).

---

## 8. Existing notions of classification / scoring / judgment

### 8.1 Scoring

- **`Reranker`** — the only capability whose response is a score. `packages/core/src/reranker/Reranker.ts:17-37`. Score contract doc at `:28-33`: "sorted descending, higher is better … no range or calibration is promised and they are not comparable across requests. Implementors must sort descending if the wire does not." Enforced provider-side by `JinaReranker.ts:114-120`.
- **`WebSearch.SearchResult.score?: number`** — `packages/core/src/web-search/WebSearch.ts:99-105`: "Relevance score, only from providers that rank (Exa, Tavily); `undefined` for providers that return an unscored list. Kept despite being non-universal because ranking is core to what a 'search result' means — and `undefined` cleanly says 'this backend doesn't score.'" Populated in `packages/providers/exa/src/ExaSearch.ts`, `tavily/src/TavilySearch.ts`, `perplexity/src/PerplexitySearch.ts`.
- **`Rank.rrf`** — `packages/retrieval/src/Rank.ts:23-38`, position-based fusion precisely _because_ scores from different retrievers are incomparable.
- **`packages/core/src/math/Vector.ts`** — `cosine`, `sparseCosine`, `maxSim` (ColBERT late interaction); referenced from `Embedding.ts:76,86-88`.

### 8.2 Judgment — exists only as a recipe, never as a capability

`/Users/janschulte/code/effect-uai/recipes/model-council/` (`recipe.ts`, `app.ts`, `recipe.test.ts`, `README.md`) is the repo's only LLM-as-judge implementation, and it is **built from `LanguageModel` + `Schema`, with no judge/score service tag**:

- `recipe.ts:13-17` `export const ScoreSchema = Schema.Struct({ score: Schema.Number, rationale: Schema.optional(Schema.String) })`; `export type Score = typeof ScoreSchema.Type`.
- `:19-20` `Schema.fromJsonString(ScoreSchema)` + `Schema.decodeResult`.
- `:22-50` `CouncilEvent` — a hand-rolled discriminated union (`"candidate_delta" | "candidate_complete" | "score" | "winner" | "error"`); the `score` arm carries `{ judge, subject, score, rationale }`, the `winner` arm `{ member, answer, averageScore }`, the `error` arm `phase: "generate" | "judge"`.
- `:53-63` `judgeHistory` — the prompt: `'You are an impartial judge. Reply ONLY with a JSON object: {"score": number 0-10, "rationale": short string}.'`
- `:65-73` `parseScore` returning `Result.Result<Score, AiError.AiError>`; `:75-127` `judgeStream`; peer-exclusion logic at `:158` (`otherJudges`).
- `Member` (`:6-10`) holds a `LanguageModelService` value directly rather than a tag, so N models can be composed in one program.

### 8.3 Other hits (not relevant to a scoring/classification capability)

- `classifyClose` / `classifyDisconnect` — WebSocket close-code triage in `packages/providers/discord/src/internal/gateway.ts:83` and `packages/providers/slack/src/internal/socket.ts:31`. Unrelated domain.
- `"classification"` / `"clustering"` / `"fact_verification"` as **embedding task enum members**: `packages/providers/google/src/GeminiEmbedding.ts:33-41` (`GoogleEmbeddingTask`) and `:88-97` (`taskToWire`), `docs/embeddings/providers/jina.md:64`, and the cross-provider note in `packages/core/src/embedding-model/EmbeddingModel.ts:45-51` that provider-specific task enums stay on the provider request.
- `packages/core/src/domain/Items.ts:243` — "Provider-side safety classifier flagged the output" (a `stop_reason` value).
- `packages/core/src/domain/Turn.ts:120` — comment mentioning "summarizers, classifiers, judge calls, and structured-output backstops" as the use case for a particular helper.
- `internal-docs/roadmap-from-assessments.md:124` — "Either way, classifiers, summarizers, judge calls, …" (a noted gap, no design).
- `internal-docs/monetisation-ideas.md:77` lists reranking among existing capabilities.
- `plans/research/reranking-plan.md:70` `### Q3. Is reranking still worth a capability?` — the closest thing to a prior "should this be a capability" analysis.
- `plans/capabilities.md:521` — "**Reranker:** lax-only, no markers (no candidates pass the bar)." The explicit precedent that a scoring capability ships with zero phantom markers.
- `packages/core/src/web-search/WebSearchTool.ts:1-50` — the pattern for exposing a capability to a model as a `Tool` (narrow model-facing `Schema.Struct` args; app-policy knobs pinned on the constructor, not exposed to the model). `packages/core/src/web-read/WebReadTool.ts` and `browser/BrowserTool.ts` are the siblings; there is **no `RerankerTool.ts`**.

---

## 9. Checklist implied by the tree, for adding a capability `Foo`

1. `packages/core/src/foo/Foo.ts` — `CommonFooRequest`, `FooResult`/`FooUsage`/`FooResponse`, `FooService`, `class Foo extends Context.Service<Foo, FooService>()("@betalyra/effect-uai/Foo")`, free-function accessors. Shared value types → `packages/core/src/domain/*.ts` if another capability will want them.
2. `packages/core/src/index.ts` — `export * as Foo from "./foo/Foo.js"`.
3. `packages/core/package.json` — `"./Foo": { types: "./dist/foo/Foo.d.mts", import: "./dist/foo/Foo.mjs" }`.
4. `packages/core/src/domain/AiError.ts` — a new variant only if needed, and then also an arm in `describe` (`:133-151`).
5. `packages/core/src/foo/Foo.test.ts` — `expectTypeOf` narrowing + marker-satisfaction tests; optionally `packages/core/src/testing/MockFoo.ts` + a `./testing/MockFoo` export.
6. `packages/providers/<vendor>/src/<Vendor>Foo.ts` — typed request via `Omit<CommonFooRequest, …> &`, typed tag `"@betalyra/effect-uai/providers/<vendor>/<Vendor>Foo"`, `Config { apiKey: Redacted.Redacted; baseUrl?: string }`, `Schema.Struct` wire schemas, the standard status table, `make` + `layer` registering both tags; `src/index.ts` + `package.json` `exports` subpath; `src/models.ts` union with `(string & {})`.
7. `recipes/_shared/model.ts` — a `fooEntries` record + `fooLayer`; `recipes/<name>/{recipe,app,run}.ts` + `README.md` (+ `recipe.test.ts`).
8. `docs/foo/index.md` (frontmatter `title`/`description`/`icon`) + `docs/foo/providers/<vendor>.md`; a sidebar group in `webpage/astro.config.mjs`; a cheat-sheet entry in `skills/effect-uai/SKILL.md`.
9. `plans/foo.md` in the `realtime.md` house style (preamble → Principles → Core design with a "Precedents this design follows" list → numbered Steps each ending in "Done when:" → Postponed → Open questions).
10. If a new npm package is involved: `.changeset/config.json` `fixed` group + the six `RELEASING.md:46-96` steps, and add it to `recipes/package.json` dependencies.
