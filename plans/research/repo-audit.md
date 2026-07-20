# Research: effect-uai repo audit

Subagent report, gathered 2026-07-15, against HEAD of `no-ticket/fix-perplexity-search`.

## 1. Package inventory

**Workspace globs** (`pnpm-workspace.yaml`): `packages/*`, `packages/providers/*`,
`packages/compat/*`, `recipes`, `webpage`, `integration-tests/*`. All
`@effect-uai/*` packages are at **v0.11.0** in a single changesets `fixed` group
(`.changeset/config.json:6-26`).

**Non-provider packages**: `packages/core` (`@effect-uai/core`),
`packages/effect-uai` (meta), `packages/compat/ai-sdk` (`@effect-uai/ai-sdk`).

**Provider capability matrix** (capability = which core service tag the package's
`layer` registers alongside its provider-typed tag):

| Package                 | Capabilities                                                                       | Wire dialect                                                         |
| ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `responses`             | **LanguageModel**, EmbeddingModel, DeepResearch                                    | OpenAI **Responses** (`POST /responses`, SSE typed events)           |
| `anthropic`             | **LanguageModel**                                                                  | Anthropic Messages (`/v1/messages`, SSE)                             |
| `google`                | **LanguageModel**, EmbeddingModel, SpeechSynthesizer, MusicGenerator, DeepResearch | Gemini generateContent                                               |
| `mistral`               | **LanguageModel**, Transcriber, SttStreaming, SpeechSynthesizer                    | **OpenAI chat-completions** (`/v1/chat/completions`) + Voxtral audio |
| `openai`                | Transcriber, SttStreaming, SpeechSynthesizer only, **no LanguageModel**            | OpenAI audio REST + realtime WS                                      |
| `jina`                  | EmbeddingModel, WebRead                                                            | Jina REST                                                            |
| `perplexity`            | WebSearch, DeepResearch, **no LanguageModel**                                      | Perplexity `/search` + `/v1/async/sonar`                             |
| `exa`                   | WebSearch, WebRead, DeepResearch                                                   | Exa REST                                                             |
| `tavily`                | WebSearch, WebRead                                                                 | Tavily REST                                                          |
| `firecrawl`             | WebRead                                                                            | Firecrawl REST                                                       |
| `elevenlabs`            | SpeechSynthesizer, Transcriber, SttStreaming, MusicGenerator                       | ElevenLabs REST + WS                                                 |
| `inworld`               | SpeechSynthesizer, Transcriber, SttStreaming                                       | Inworld REST + WS                                                    |
| `browser`               | Browser                                                                            | CDP                                                                  |
| `deno` / `microsandbox` | Sandbox                                                                            | —                                                                    |

**No Reranking capability exists anywhere.** No `Reranker` tag in core, no rerank
code in `jina`. But `packages/providers/jina/package.json:4,10` advertises
`"rerank"` in its description and keywords, and `docs/reranking/index.md` is a
"Coming soon" page. Live metadata/implementation discrepancy in a published
package.

**Key structural finding**: `@effect-uai/mistral` is the **only** implementation
of the OpenAI chat-completions dialect in the repo. `@effect-uai/openai` is
speech-only; the OpenAI LanguageModel lives exclusively in `responses`.

## 2. Deep-dive: `packages/providers/mistral/`

LOC: `codec.ts` 338, `MistralSynthesizer.ts` 285, `realtimeStt.ts` 256,
`MistralTranscriber.ts` 224, `Mistral.ts` 194, `audioCodec.ts` 123,
`codec.test.ts` 121, `onHalt.test.ts` 75, `models.ts` 47, `http.ts` 46,
`MistralRealtimeTranscriber.ts` 60, `index.ts` 6. Total 1775.

### Public API surface (`Mistral.ts`)

- `MistralRequest` (`:32-44`) = `Omit<CommonRequest, "model">` + `model: MistralModel`
  - `safePrompt?: boolean` + `randomSeed?: number`.
- `MistralService` (`:46-51`) = `{ streamTurn, turn }`, same two methods as core,
  narrowed to `MistralRequest`.
- `class Mistral extends Context.Service<Mistral, MistralService>()("@betalyra/effect-uai/providers/mistral/Mistral")` (`:58-60`).
- `Config` (`:62-65`): `{ apiKey: Redacted.Redacted; baseUrl?: string }`.
- `make(cfg): Effect<MistralService, never, HttpClient>` (`:165`);
  `layer(cfg): Layer<Mistral | LanguageModel, never, HttpClient>` (`:179`), which
  `Layer.merge`s a typed layer and a generic `LanguageModel` layer over **two
  separate `make(cfg)` calls** (`:182-193`), despite the doc comment at `:176-178`
  saying "sharing one underlying implementation". Harmless (stateless closures)
  but the comment overstates it.

### The codec (`codec.ts`)

- **items → messages** (`:86-102`): `Arr.reduce` fold. `message` → `{role, content}`;
  `function_call` → folded onto the preceding assistant message via
  `appendToolCall` (`:70-84`), which checks
  `last.role === "assistant" && last.tool_call_id === undefined`;
  `function_call_output` → its own `{role:"tool", tool_call_id, content}`;
  **`reasoning` items are dropped** (`:96`). `encodeContent` (`:59-62`) collapses
  text-only content to a plain string, else emits multimodal parts.
- **tools → wire** (`:108-123`):
  `{type:"function", function:{name, description, parameters: inputSchema, strict?}}`,
  `Option.none()` when empty.
- **tool_choice** (`:132-138`): `auto`/`none` pass through; **`required` → `"any"`**;
  named → `{type:"function", function:{name}}`.
- **response_format** (`:140-149`): `{type:"json_schema", json_schema:{name, schema, strict?}}`,
  schema via `structured.schema["~standard"].jsonSchema.input({target:"draft-2020-12"})`.
- **SSE decode**: `WireChunk` schema (`:184-188`) →
  `decodeChunk = Schema.decodeUnknownEffect(WireChunk)` (`:190`). `decodeEvent` in
  `Mistral.ts:101-104` returns `None` for `[DONE]` and swallows unmodelled
  payloads via `Effect.option` so keep-alives never abort the turn.
- **`applyChunk(acc, chunk): [Accumulator, TurnEvent[]]`** (`:303-312`), pure fold.
  Tool calls keyed by wire `index` with positional fallback (`:257`), `call_id`
  fallback `call_${index}` (`:261`). Emits `TextDelta`, `ToolCallStart`,
  `ToolCallArgsDelta`, `UsageUpdate`.
- **`accumulatorToTurn`** (`:315-338`) assembles `{items, usage, stop_reason}`;
  `stopReasonOf` (`:237-241`) falls back to `tool_calls`/`stop` when no
  `finish_reason` was seen.
- Streaming is wired with `Stream.mapAccum(..., { onHalt })` (`Mistral.ts:147-154`),
  and `onHalt` **only emits `TurnComplete` if `finishReason` is Some**, the guard
  against synthesizing a complete turn from a truncated stream.

### Mistral-specific vs generic chat-completions

**Mistral-only** (every place):

1. `toolChoiceWire`: `"required"` → `"any"` (`codec.ts:131-138`), the one documented
   divergence, tested at `codec.test.ts:60-63`.
2. `safe_prompt` (`Mistral.ts:80`) and `random_seed` (`Mistral.ts:81`) body fields.
3. `image_url` emitted as a **bare string**, not OpenAI's `{url: "..."}` object
   (`codec.ts:45`, asserted at `codec.test.ts:48-56`).
4. `reasonToStop`: `"model_length"` → `max_tokens` (`codec.ts:231`), a Mistral-only
   `finish_reason` value.
5. Base URL default `https://api.mistral.ai` + hardcoded path `/v1/chat/completions`
   (`Mistral.ts:111-112`).
6. `provider: "mistral"` hardcoded in every `AiError` construction (`http.ts:9-42`,
   `Mistral.ts:129,140`).
7. `MistralModel` union (`models.ts:12-23`).
8. Auth hardcoded to `Authorization: Bearer` via `Redacted.value(cfg.apiKey)` string
   interpolation (`Mistral.ts:120`). Note this unwraps the Redacted rather than
   using `HttpClientRequest.bearerToken`, which other packages use.
9. `stream: true` unconditionally (`Mistral.ts:75`), no non-streaming path; `turn`
   is derived via `turnFromStream`.

**Generic OpenAI chat-completions** (would lift unchanged into a shared base):
`itemsToMessages` fold, `toolsWire`, `responseFormatWire`, the `Wire*` schemas,
`applyChunk`/`Accumulator`/`accumulatorToTurn`, the SSE `[DONE]` handling, and
most of `http.ts`'s status mapping.

### `http.ts` (46 LOC)

Error mapping only, no base URL, no auth helper. `httpStatusError(status, body)`:
429→`RateLimited`, 408/504→`Timeout`, 401→`AuthFailed{subtype:"auth"}`,
403→`AuthFailed{subtype:"permission"}`, 402→`AuthFailed{subtype:"billing"}`,
413→`ContextLengthExceeded`, ≥500→`Unavailable{status}`, else→`InvalidRequest`.
Plus `transportFailure`.

### Test coverage

- `codec.test.ts` (121): tool-call folding onto the assistant message; multimodal
  image encoding; `required`→`any`; text+usage accumulation into a turn; a tool
  call stitched across chunks.
- `onHalt.test.ts` (75): a truncated EOF (no `finish_reason`) must **not**
  synthesize `TurnComplete`; a mid-stream error must surface as a failure not a
  fake `TurnComplete`; a well-formed stream still completes. Uses a scripted
  `HttpClient.make` fake.
- **Not covered**: `responseFormatWire`, `toolsWire`, `buildRequestBody` (so
  `safe_prompt`/`random_seed` are untested), `http.ts` status mapping.

## 3. Deep-dive: `packages/providers/responses/`

LOC: `Responses.ts` 385, `codec.ts` 344, `OpenAIEmbedding.ts` 307,
`OpenAIDeepResearch.ts` 266, `streamEvents.ts` 244, `ResponsesTools.ts` 158,
`models.ts` 56, `region.ts` 29, `index.ts` 8; tests `responsesTools.test.ts` 146,
`region.test.ts` 26.

- **Service construction**: `class Responses extends Context.Service<Responses, ResponsesService>()(...)`
  (`Responses.ts:103-105`). `ResponsesService` (`:67-95`) is richer than core's:
  `{ streamNative, streamTurn, turn, toCanonical }`. `make` (`:349-361`) captures
  the client with `Effect.map(HttpClient.HttpClient, ...)` and pins it via
  `Stream.provideService`, so `R = never`; `turn` derived via `turnFromStream` (`:358`).
- **Config** (`:107-111`): `{ apiKey: Redacted.Redacted; baseUrl?: string; region?: OpenAiRegion }`.
  `OpenAIEmbedding.ts:59-63` is identical; `OpenAIDeepResearch.ts:54-60` adds
  `job?: Job.JobConfig`. No shared base type; **no `layerConfig` anywhere in the
  repo** (zero grep hits), callers do `Config.redacted(...)` themselves.
- **Layer wiring** (`:370-385`): same `Layer.merge(typed, generic)` shape as
  Mistral, also calling `make(cfg)` twice.
- **Annotations/citations**, two paths: bundled on the turn (`codec.ts:10-43` wire
  schemas; carried onto `ContentBlock` at `codec.ts:239-243`; surfaced via core
  `Turn.citations`), and streamed (`streamEvents.ts:69-72`
  `response.output_text.annotation.added` → `TurnEvent.CitationAdded` at `:222-224`).
  The provider's `WireAnnotation` is passed **structurally** into core's
  `Items.Annotation` with no conversion function, a latent hand-maintained coupling.
- **Base URL is configurable today.** `region.ts:22-29` `resolveHost` returns
  `cfg.baseUrl` unconditionally when set (guarded by `region.test.ts:21-25` using
  `http://localhost:8080/v1`). Call sites: `Responses.ts:289`,
  `OpenAIEmbedding.ts:187`, `OpenAIDeepResearch.ts:136,167,187,206`.
  `docs/providers/responses.md:58` endorses it for "proxies / Azure / local LLM
  gateways".

**Can a third party point it at a different base URL today?** Yes for URL + bearer
auth. Four blockers for it being a real reuse story:

1. Auth is fixed to `HttpClientRequest.bearerToken` (`Responses.ts:310-314` and
   every other call site), no `authHeader` hook, no extra headers. Azure's
   `api-key` / custom `x-api-key` can't be expressed except by wrapping
   `HttpClient` externally.
2. Path shape fixed (`${host}/responses`, `${host}/embeddings`).
3. `provider` tag on `AiError` hardcoded to `"responses"`
   (`:206,212,219,248-255,275,319`) / `"openai"`
   (`OpenAIEmbedding.ts:74,162,175,213,292,299`), wrong labels for a third party's
   error routing/telemetry.
4. `ResponsesTools.ts:137-141` rejects any hosted tool whose `tool.provider !== "openai"`.

**Existing "OpenAI-compatible provider reusing responses" pattern? No.** Zero
packages import `@effect-uai/responses`. `region.ts` is a **copy**, not shared:
`responses/src/region.ts:8-9` says so explicitly ("Defined locally... to keep the
packages decoupled"); `openai/src/region.ts` and `elevenlabs/src/region.ts` are
further copies. House style is duplicate-to-decouple. The only working reuse is
**intra-package**: `OpenAIDeepResearch.ts:17` imports `httpStatusError`,
`providerEventsOfResponse`, `toCanonical` from `./Responses.js`, i.e. export the
decode pipeline, let the sibling supply its own Config/URL/body.

## 4. Deep-dive: `packages/providers/jina/`

Implements **Embedding + WebRead only** (no rerank, see section 1). LOC:
`JinaEmbedding.ts` 575, `JinaReader.ts` 198, `models.ts` 39, `index.ts` 3.

- Tags: `JinaEmbedding` (`:100-102`) + core `EmbeddingModel`; `JinaReader` (`:41-43`)
  - core `WebRead`. Both `layer(cfg) = Layer.merge(typed, generic)`; signatures at
    `JinaEmbedding.ts:504,529` and `JinaReader.ts:177,189`.
- `Config` declared **twice, separately**, structurally identical
  (`JinaEmbedding.ts:104-107`, `JinaReader.ts:45-48`):
  `{ apiKey: Redacted.Redacted; baseUrl?: string }`.
- Base URLs: embeddings `https://api.jina.ai/v1` → `POST /embeddings` (`:387,395`);
  reader `https://r.jina.ai` → `GET /${url}` (`:140,149`). Auth:
  `HttpClientRequest.bearerToken(cfg.apiKey)` in both (`:396`, `:150`).
- **No `http.ts`**: `transportFailure`/`httpStatusError` are duplicated in both
  modules (`JinaEmbedding.ts:295-296,370-381`; `JinaReader.ts:125-138`), and the
  copies have **drifted**: the embedding copy maps `413 → ContextLengthExceeded`
  (`:378`), the reader copy omits it.
- Generic registration adapts: `mapGenericTask` (`:488`) maps `query`/`document` →
  `retrieval.query`/`retrieval.passage`; `assertEncoding` restricts to
  `["float32","binary"]` (`:547,561`).

## 5. Deep-dive: `packages/providers/perplexity/`

**WebSearch + DeepResearch only. There is definitively NO chat-completions
LanguageModel here.** Nothing imports `@effect-uai/core/LanguageModel`; the only
endpoints are `POST /search` (`PerplexitySearch.ts:185`), `POST /v1/async/sonar`
(`PerplexityDeepResearch.ts:202`), `GET /v1/async/sonar/{id}` (`:222`).
`package.json` exports only `.`, `./PerplexitySearch`, `./PerplexityDeepResearch`.

LOC: `PerplexityDeepResearch.ts` 291, `PerplexitySearch.ts` 238, `models.ts` 32,
`http.ts` 19, `index.ts` 3.

Notable for a future chat-completions addition: `PerplexityDeepResearch.ts`
**already contains most of the codec**: `WireChoice`/`WireUsage`/`WireCompletion`
(`:65-83`), `historyToMessages` (`:105`), `completionToTurn` (`:132`),
citation→`Annotation` mapping (`:116`). And `models.ts:23-27` already types
`sonar`/`sonar-pro`/`sonar-reasoning-pro` with a comment that they "are meant for
the sync chat endpoint", i.e. the model union anticipates an endpoint that doesn't
exist yet.

Two inconsistencies worth flagging:

- **Auth differs between the two modules.** Search uses `bearerToken` (`:186`);
  DeepResearch hand-rolls `` `Bearer ${Redacted.value(cfg.apiKey)}` `` (`:185-186`),
  unwrapping the Redacted into a plain header string.
- **`PerplexitySearch.ts` doesn't use `http.ts` at all**: it re-declares
  byte-equivalent `transportFailure` (`:162`) and `httpStatusError` (`:165`). Only
  DeepResearch imports it (`:15`). `http.ts` looks like a half-finished extraction.

### Commit `e1461eb` "Fix perplexity bug"

Two files, 22 insertions / 15 deletions; **one real behavior change**, rest is docs.

The bug: `buildBody` spread `search_context_size` and `max_tokens_per_page`
independently, so setting both sent both. Perplexity's `/search` rejects that
combination with a **500** (both govern per-page extraction), which maps through
`httpStatusError` to `AiError.Unavailable`, so callers saw a misleading "provider
is down" for their own bad request. The fix (`PerplexitySearch.ts:107-114`) makes
them mutually exclusive in the codec, token cap winning:

```ts
...(request.maxTokensPerPage !== undefined
  ? { max_tokens_per_page: request.maxTokensPerPage }
  : request.searchContextSize !== undefined && {
      search_context_size: request.searchContextSize,
    }),
```

The doc hunks (`PerplexitySearch.ts:26-28`, `models.ts:1-15`) correct a wrong
mental model: `searchContextSize` was documented as _how many pages are fetched_;
it's actually per-page **extraction depth**, which is exactly why it collides with
`max_tokens_per_page`. Caveat: the new `models.ts` comment claims `max_tokens`
also collides, but `WireBody` (`:58-69`) has no `max_tokens` field, so only the
`max_tokens_per_page` half is reachable through this codec.

## 6. Core LanguageModel service

`packages/core/src/language-model/LanguageModel.ts` (99 LOC):

```ts
export type CommonRequest = {
  readonly history: ReadonlyArray<HistoryItem>
  readonly model: string
  readonly tools?: Toolkit
  readonly toolChoice?:
    | "auto"
    | "required"
    | "none"
    | { readonly type: "function"; readonly name: string }
  readonly temperature?: number
  readonly topP?: number
  readonly maxOutputTokens?: number
  readonly structured?: StructuredFormat.StructuredFormat<unknown>
} // :14-42

export type LanguageModelService = {
  readonly streamTurn: (request: CommonRequest) => Stream.Stream<TurnEvent, AiError.AiError>
  readonly turn: (request: CommonRequest) => Effect.Effect<Turn, AiError.AiError>
} // :44-56

export class LanguageModel extends Context.Service<LanguageModel, LanguageModelService>()(
  "@betalyra/effect-uai/LanguageModel",
) {} // :58-60
```

Plus module-level accessors `streamTurn` (`:65`), `turn` (`:76`), and the shared
helper `turnFromStream<Req>(streamTurn) => (request) => Effect<Turn, AiError>`
(`:85-98`) which `runCollect`s, `findLast(isTurnComplete)`, and fails
`AiError.IncompleteTurn` if absent.

**Domain types** (`packages/core/src/domain/`, Effect Schema-based):

- `Items.ts` (241): `ContentBlock = InputText | InputImage | OutputText | Refusal`
  (`:103`); `HistoryItem = Message | ToolCall | ToolCallOutput | Reasoning` (`:163`);
  `Annotation = UrlCitation | FileCitation | ContainerFileCitation | FilePath` (`:76`);
  `Role = user|assistant|system` (`:106`); `Usage` (`:194`), `StopReason` (`:203`).
  `Schema.is` guards for every variant.
- `Turn.ts` (197): `Turn = { items, usage, stop_reason }` (`:23`); `TurnEvent` is a
  `Data.TaggedEnum` (`:57-73`) with `TextDelta`, `ReasoningDelta`, `RefusalDelta`,
  `ToolCallStart`, `ToolCallArgsDelta`, `UsageUpdate`, `WebSearchCall`,
  `CitationAdded`, `TurnComplete`. Projections: `citations` (`:117`),
  `assistantText` (`:110`), `getToolCalls` (`:85`), `decodeStructured` (`:188`).

**Provider contract**: implement `streamTurn` as the single source of truth
(streaming-first, Mistral hardcodes `stream: true`), derive `turn` via
`turnFromStream`, fail only in the `AiError.AiError` channel, leave
`HttpClient.HttpClient` in `R` on `make` but eliminate it in the service value via
`Stream.provideService`, and register both a provider-typed `Context.Service` tag
and the generic `LanguageModel` tag from one `layer(cfg)` via `Layer.merge`.

## 7. Repo conventions

- **Provider package.json**: `@effect-uai/<name>`, v0.11.0, `"type":"module"`,
  ESM-only (`main: ./dist/index.mjs`, `types: ./dist/index.d.mts`), per-module
  subpath `exports` (`.`, `./Mistral`, `./MistralTranscriber`, …),
  `files: [dist, src, README.md, LICENSE]`, `publishConfig.access: public`, scripts
  only `build: tsdown` + `typecheck: tsc --noEmit`. **Peer deps, not deps**:
  `@effect-uai/core` (`workspace:>=0.2.0 <1`), `effect`
  (`>=4.0.0-beta.94 <5.0.0`), optional native peers (`ws`) marked in
  `peerDependenciesMeta`. No runtime dependencies; no bundled HTTP client.
- **Build**: `tsdown.config.ts` per package: `entry: ["src/**/*.ts"]`,
  `format: "esm"`, `dts: {sourcemap:true}`, `target: "es2022"`, `outDir: "dist"`,
  `clean: true`. `tsconfig.json` extends `../../../tsconfig.base.json`. Root:
  `pnpm build` = `pnpm --filter "@effect-uai/*" -r build`; `pnpm typecheck` =
  `pnpm -r typecheck`; `pnpm format` = `oxfmt`; also `lint:effect` via
  `effect-language-service`.
- **Tests**: vitest, root `vitest.config.ts` includes `**/*.test.ts`, excludes
  `node_modules`/`dist`/`integration-tests`. Tests are **co-located in `src/`**
  (`src/codec.test.ts`, `src/onHalt.test.ts`). Integration tests are separate roots
  under `integration-tests/` with their own vitest invocations
  (sandbox-microsandbox, sandbox-deno), excluded from the workspace glob.
- **Docs**: `docs/` is the source; `webpage/` renders it (per-provider routes under
  `webpage/dist/providers/{gemini,responses,anthropic,mistral}`, plus
  capability-scoped provider pages like `docs/embeddings/providers/jina.md`,
  `docs/speech/providers/`, `docs/search/providers/`, `docs/web-reading/providers/`).
  A LanguageModel provider page follows a fixed section order, see
  `docs/providers/mistral.md`: `## Install`, `## Wire it up`, `## Config`,
  `## Calling it`, `## Per-call options`, `### Tools`, `### Structured output`,
  `## Models`, `## Errors`.
- **Recipes**: `recipes/<name>/` with `README.md`, `index.ts`, `index.test.ts`,
  `run.ts` (runtime-suffixed when runtime-specific). ~35 recipes; the `recipes`
  workspace member is `@effect-uai/recipes`, ignored by changesets. `examples/`
  holds standalone apps (`ai-sdk-next`) deliberately outside the workspace glob.
- **Changesets**: single `fixed` group over all 18 published packages,
  `access: public`, `baseBranch: main`, `updateInternalDependencies: patch`.

## Cross-cutting observations

1. **The chat-completions dialect exists once, inlined in Mistral**, and the plan to
   extract it (`plans/openai-compatible-chat.md`) is already written, with Mistral's
   `codec.test.ts` named as the regression guard. Perplexity's sync sonar is the
   plan's first target, and its DeepResearch module already carries most of the
   needed codec.
2. **`Config` is copy-pasted per module, never shared**: 3 identical declarations in
   `responses`, 2 in `jina`, 2 in `perplexity`. Same for
   `httpStatusError`/`transportFailure` (37 files) and `region.ts` (3 copies,
   deliberately per `responses/src/region.ts:8-9`).
3. **Auth handling is inconsistent within packages**: `bearerToken` (Jina both,
   Perplexity Search, all of `responses`) vs `Redacted.value` string interpolation
   (Mistral `Mistral.ts:120`, Perplexity DeepResearch `:185-186`). The latter
   unwraps the secret into a plain header value.
4. `layer(cfg)` calls `make(cfg)` twice in both `responses` (`:370-385`) and
   `mistral` (`:182-193`) while the comment claims a shared implementation.
5. `@effect-uai/jina` ships rerank in its published description and keywords with no
   rerank code.
