# @effect-uai/core

## 0.14.0

### Minor Changes

- dd5d61a: New `ImageGenerator` capability (additive). A prompt goes in, images come out,
  and the same call runs on any provider whose Layer you swap in.

  - **`@effect-uai/core/ImageGenerator`**: the generic `ImageGenerator` tag plus
    `generate`, `edit`, and `streamGeneration` helpers. A request is
    `{ prompt, model, aspectRatio?, resolution?, n? }`; `edit` adds the reference
    `images` it conditions on. A response is
    `{ images: [{ image, watermark? }], usage }`, where `image` is the same
    `ImageSource` you pass into a multimodal language model, so a generated image
    feeds the next turn with no conversion.
  - Size is a shape plus a tier (`aspectRatio` + `resolution`), not pixels:
    pixel pairs do not port between providers. Adapters whose wire wants exact
    dimensions derive them; exact pixels stay available on the provider-typed
    request.
  - **`ImageStreaming`**: capability marker gating `streamGeneration`. A provider
    without a partial-image wire does not register it, so previewing against that
    Layer is a compile-time error.
  - **`AspectRatio`** joins `@effect-uai/core/Media` alongside `Watermark`, which
    moved there from `Music` (re-exported unchanged) now that image results carry
    one too. `ImageResolution` and `GeneratedImage` are in
    `@effect-uai/core/Image`.

  - **`@effect-uai/openai/OpenAIImageGenerator`**: the first provider, on the
    Images API with `gpt-image-2`. Registers the typed tag, the generic one, and
    `ImageStreaming`. The typed request adds exact `size`, `quality`,
    `background`, `outputFormat`, `outputCompression`, `moderation`, and a `mask`
    for inpainting. `baseUrl` and `region` work as on the other OpenAI adapters,
    so the same Layer reaches an OpenAI-compatible gateway.
  - Ratio and tier become `"WxH"` in the adapter. A ratio the arithmetic cannot
    consume fails `InvalidRequest`; setting `size` alongside `aspectRatio` or
    `resolution` warns rather than dropping the shape silently. Range and
    per-model limits are not checked client-side: the request goes out and the
    endpoint's error is translated. Moderation blocks become `ContentFiltered`,
    an empty response `GenerationFailed`.

  See [image generation](https://effect-uai.betalyra.com/image-generation/).

- a7e3bc6: Images inside a language-model turn. Some models answer with a picture rather
  than only text, and "make it dawn instead" changes that same picture, so the
  image belongs on the turn instead of behind a separate call.

  - **`output_image`** joins the `ContentBlock` union: a block on the assistant's
    message carrying the same `ImageSource` an `input_image` does.
    `Turn.assistantImages` pulls them out in order. Do not count on the text
    alongside it, since these models often return none.
  - **`ImageOutput`** joins `TurnEvent`, with `partialIndex` set only on a
    preview frame. It also lands on `TurnComplete.turn`, so reading the
    assembled turn misses nothing.
  - **`Turn.imagesAsInput`** restates assistant-drawn images as a following user
    message of `input_image` blocks. Explicit rather than automatic, because
    "the assistant drew this" and "here is an image, look at it" are not the
    same claim.
  - **`Capabilities.warnDroppedBlocks`** reports content a wire has no slot for,
    counted per request.
  - Only Gemini's wire carries an assistant-drawn image, so replaying one there
    is what lets a follow-up edit it. Every other adapter drops the block on
    replay and warns once per request, naming `imagesAsInput` as the way to
    resend it.

  See [images in a turn](https://effect-uai.betalyra.com/language-models/images-in-turns/).

### Patch Changes

- c49ff25: Fix multipart uploads hanging forever under `NodeHttpClient.layerUndici`.

  `HttpClientRequest.bodyFormData` keeps the `FormData` object, and the Undici
  client passes it straight to `dispatcher.request`, which cannot serialise it:
  the request is never sent, and the effect waits with no error and no timeout.
  The `node:http` and fetch clients encode first, so only Undici was affected,
  which made JSON endpoints work while every multipart one on the same provider
  hung. This hit OpenAI image edits and transcription, ElevenLabs
  speech-to-text, and Mistral transcription.

  New `@effect-uai/core/Multipart` exports `bodyMultipart`, which encodes the
  form to bytes and sets the boundary content-type, so the request works on
  every client. All four call sites use it.

## 0.13.0

### Minor Changes

- 4b8c49f: New `Reranker` capability (additive). Give it a query and a candidate set, get
  back scored positions, best first. It is a per-hop filter for agent loops:
  anywhere a search, a retrieval, or a tool produces more candidates than the
  model can afford to read.

  - **`@effect-uai/core/Reranker`**: the generic `Reranker` tag and the
    `rerank(request)` helper. A request is `{ query, documents, model, topN? }`;
    a response is `{ results: [{ index, score }], usage }`, where `index` points
    back into the `documents` you passed. `results` is sorted descending and
    higher is better, but scores are not calibrated and are not comparable across
    calls, so cut by rank rather than by a fixed threshold.
  - **`@effect-uai/jina/JinaReranker`**: the first provider, registering both the
    typed `JinaReranker` tag and the generic one. Models are `jina-reranker-v3.5`
    (default), `jina-reranker-v3`, and `jina-reranker-m0`. The typed request
    widens `documents` to `{ text }` / `{ image: ImageSource }` for m0's visual
    documents, using the same `ImageSource` helpers as multimodal embedding; the
    cross-provider request stays strings-only.

  See [reranking](https://effect-uai.betalyra.com/reranking/).

  See [Migrating to 0.13](https://effect-uai.betalyra.com/migrations/v0-13/).

- 50d0a9c: Add `@effect-uai/retrieval`, the step before embedding: split documents into
  passages, size them by real tokens, and merge results from searches that do not
  share a score scale.

  Core gains two capability tags for it. `Chunker` (`@effect-uai/core/Chunker`)
  splits a document into `Chunk`s, so ingest code never names a strategy and a
  hosted chunking service can replace a local splitter at the layer.
  `Tokenizer` (`@effect-uai/core/Tokenizer`) encodes and decodes text.

  ```ts
  import { chunk } from "@effect-uai/core/Chunker"
  import * as Chunking from "@effect-uai/retrieval/Chunking"

  const ingest = Effect.gen(function* () {
    const passages = yield* chunk(document)
  })

  const chunker = Chunking.layer(Chunking.recursive, { targetSize: 512 })
  ```

  `Chunking` ships four chunkers, all pure and all reporting the offsets each
  passage came from, so a hit can be traced back to its source: `recursive`
  (the default, breaking on paragraphs then lines then sentences then words),
  `sentences`, `markdown` (one chunk per heading, leaving fenced code intact),
  and `fixed`.

  `Rank.rrf` is reciprocal rank fusion, for combining a keyword leg and a vector
  leg whose scores mean nothing to each other:

  ```ts
  import * as Rank from "@effect-uai/retrieval/Rank"

  Rank.rrf([lexicalIds, denseIds], { weights: [1, 0.7] })
  // => [{ value: id, score }, ...] best first
  ```

  `HuggingFaceTokenizer` implements `Tokenizer` over any Hub repo with a
  `tokenizer.json`, behind an optional peer dependency on
  `@huggingface/tokenizers`. Downloading and building are separate, so you cache
  the vocabulary wherever you already keep things instead of refetching on every
  boot, and gated repos take an access token.

  See [Migrating to 0.13](https://effect-uai.betalyra.com/migrations/v0-13/).

## 0.12.1

### Patch Changes

- 23b1913: Require Effect `4.0.0-rc.111`

  The `effect` peer range moves from `>=4.0.0-beta.94 <5.0.0` to
  `>=4.0.0-rc.111 <5.0.0` across every package. Effect's rc line changed APIs the
  beta line still had (for example `Schedule.both` is gone in favour of
  `Schedule.upTo`), so a beta install is no longer supported.

- 067d018: Use `Schema.TaggedError` instead of the removed `Schema.TaggedErrorClass`

  Effect renamed `Schema.TaggedErrorClass` to `Schema.TaggedError` in
  `4.0.0-beta.104`. `Tool.ts` still called the old name, so importing
  `@effect-uai/core/Tool` threw `TypeError: Schema.TaggedErrorClass is not a
function` on every Effect from `beta.104` onward, including the current `beta`
  and `rc` dist-tags. The argument shape is unchanged, so this is a rename only.

## 0.12.0

### Minor Changes

- f86ffd3: Report Anthropic cache-creation (write) tokens, and fix a stale `total_tokens`
  on streamed turns.

  Anthropic bills input across three separate buckets: `input_tokens`
  (post-breakpoint), cache reads, and cache writes. The provider decoded the
  write bucket but dropped it, so a turn that populated the cache logged
  `cached 0` and the priciest tokens were invisible in telemetry.
  - `Items.Usage.input_tokens_details` gains `cache_write_tokens` (mirrors the
    OpenAI Responses usage field name). Note `cached_tokens` / `cache_write_tokens`
    are provider-relative: Anthropic reports `input_tokens` as post-breakpoint
    only, so the buckets are additive; OpenAI counts cache reads inside
    `input_tokens`. Read each provider's usage in its own terms.
  - The anthropic codec now maps `cache_creation_input_tokens` to
    `cache_write_tokens` and computes `total_tokens` from the accumulated usage
    (all input buckets plus output). Previously `total_tokens` was set from a
    single wire event, leaving it frozen at the `message_start` figure for
    streamed turns.
  - `Metrics` folds it in alongside cached tokens: `tokenTotals` cumulates it and
    emits an `effect_uai_cache_write_tokens` counter measurement.

### Patch Changes

- 3831f0c: `Metrics.throughput` now measures every delta that carries generated output, not
  just `TextDelta`. `ReasoningDelta`, `RefusalDelta` and `ToolCallArgsDelta` count
  too.

  Previously a tool-using agent measured a rate near zero for an entire run: its
  output is mostly `ToolCallArgsDelta`, and only prose was counted. Anyone
  charting `effect_uai_output_*_per_second` for such an agent will see the number
  jump from ~0 to a real rate. Prose-only turns are unaffected.

  `ThroughputOptions.tokenizer` is now called with the new `OutputDelta` type
  rather than `TurnEvent`, since it only ever receives output-carrying deltas.
  Existing tokenizers that accept a full `TurnEvent` remain assignable.

  `timeToFirstToken` keeps its own narrower definition of a content delta and is
  unchanged.

## 0.11.0

### Minor Changes

- 1efb6b4: New `DeepResearch` capability (additive). Submit a question, a provider runs a
  long-running background research job (many web searches over minutes), and you
  collect one cited report.
  - **`@effect-uai/core/DeepResearch`**: the generic `DeepResearch` tag and the
    portable accessors `research` (submit and poll to the terminal `Turn`),
    `researchStream` (submit and forward live `TurnEvent`s, terminating in
    `TurnComplete`), plus the detached trio `submit` / `status` / `collect` /
    `streamFrom` / `cancel`. A completed result is a plain `Turn` (project it with
    `Turn.assistantText` / `Turn.citations` / `Turn.decodeStructured`); the
    streaming terminal and the collected value are the same shape.
  - **`@effect-uai/core/Job`**: the generic background-job primitive the capability
    is built on. A `JobRef<A>` is serializable `{ _tag, provider, id }` data, so a
    job can be submitted now and collected from a later process. `Job.collect` /
    `Job.run` drive the poll-to-settle loop; `Job.JobConfig` tunes poll cadence
    (default 10s) and overall timeout (default 45m).
  - **`@effect-uai/core/Research`** and **`@effect-uai/core/Citation`**: the shared
    `ResearchRequest` and the provider-agnostic `Citation` / `Source` /
    `CitationSpan` model that normalizes how providers link answer text to sources
    (char span, quote, positional marker, or bare source).
  - Providers register the generic `DeepResearch` tag plus a provider-typed tag
    for the narrowed knobs: `@effect-uai/responses/OpenAIDeepResearch`
    (`o3-deep-research`, submit creates a streaming background job),
    `@effect-uai/google/GoogleDeepResearch` (Gemini Interactions, real streaming),
    `@effect-uai/perplexity/PerplexityDeepResearch` (`sonar-deep-research`,
    poll-only with a synthesized stream), and `@effect-uai/exa/ExaDeepResearch`
    (`exa-research`, poll-only, with a provider-typed `outputSchema` for
    structured output).

  Every provider is modeled as a job (`submit` / `poll` / `cancel`), so
  `fromJob(ops, config?)` derives the whole uniform surface once and an
  implementor states only its wire calls. See the
  [native deep research recipe](https://effect-uai.betalyra.com/recipes/native-deep-research/).

- 1efb6b4: Native grounding: provider-hosted tools now render end to end (additive). Add a
  provider tool to a `Toolkit` alongside your function tools and the adapter maps
  it to the model's native `tools` entry, so the model can search the web, ground
  against Google Search, run code, or read files without you wiring the loop.
  - **`@effect-uai/core/Tool`**: `Tool.isProviderTool` and `Tool.providerToolsOf`
    partition provider tools out of a toolkit so an adapter can render them
    separately from the function declarations.
  - **`@effect-uai/responses/ResponsesTools`**: `webSearchTool`,
    `codeInterpreterTool`, `fileSearchTool` (OpenAI-hosted).
  - **`@effect-uai/google/GeminiTools`**: `googleSearchTool`, `urlContextTool`,
    `codeExecutionTool` (Gemini-hosted).
  - **`@effect-uai/anthropic/AnthropicTools`**: `webSearchTool`,
    `codeExecutionTool` (Anthropic-hosted).

  A provider tool the target adapter cannot render (a foreign `provider` or an
  unrecognized `config`) fails a typed `AiError.Unsupported` rather than being
  dropped. See the
  [native grounding recipe](https://effect-uai.betalyra.com/recipes/native-grounding/).

- 1efb6b4: `Tool.make` and `Tool.provider` now accept an Effect `Schema` directly as
  `inputSchema` and adapt it internally, so you no longer wrap it in
  `Tool.fromEffectSchema`. The `Input` type is still inferred from the schema.
  `fromEffectSchema` / `fromStandardSchema` remain for the explicit path and for
  non-Effect Standard Schemas (Zod, Valibot, ArkType). Existing call sites are
  unchanged.

### Patch Changes

- 1efb6b4: Bug fixes.
  - **`Toolkit.namespace`** now preserves a tool's typed error `E` and requirement
    `R` through the prefixing rewrite (they were previously widened).
  - **SSE and JSONL decoders** (`@effect-uai/core/SSE`, `@effect-uai/core/JSONL`)
    are now backed by Effect's `unstable/encoding` primitives, for spec-correct
    framing across chunk boundaries.
  - **`Items.UrlCitation`** widens to the provider-agnostic citation shape:
    `start_index` / `end_index` become optional and `cited_text` / `marker` are
    added, so a provider populates whichever anchor it has (offset span, exact
    quote, or positional `[n]` marker) and a bare source list sets none.
  - **Mistral** no longer synthesizes a `TurnComplete` for a truncated or failed
    stream, so a halted turn surfaces as a failure instead of a bogus completion.

- 1efb6b4: Track the latest Effect v4 beta across every package. The `effect` peer
  dependency moves from `4.0.0-beta.57` to a range, `>=4.0.0-beta.94 <5.0.0`, so
  consumers must be on `effect@4.0.0-beta.94` or newer. This is the one required
  action for the upgrade; the API surface is otherwise source-compatible. Most of
  the internal diff in this release is the mechanical ripple of that bump. See the
  [0.11 migration guide](https://effect-uai.betalyra.com/migrations/v0-11/).

## 0.10.0

### Minor Changes

- 98ee12c: New `Browser` capability (additive). Drive a real browser over the Chrome
  DevTools Protocol: navigate, click, fill, press, scroll, and read a page as
  markdown with its interactive elements labeled.
  - **`@effect-uai/core/Browser`**: the generic `Browser` tag and session
    surface, with a typed `BrowserError`.
  - **`@effect-uai/core/BrowserTool`**: verb tools (`gotoTool`, `clickTool`,
    `fillTool`, `pressTool`, `scrollTool`) and `browserToolkit(session)` that
    bundles them, for handing the browser to an agent loop.
  - **`@effect-uai/browser`** (new package): a CDP adapter. Point
    `@effect-uai/browser/Connect`'s `layer({ endpoint })` at any browser-level
    CDP WebSocket, which covers the whole field: a headless Chromium container,
    a local Chrome or Edge, a from-scratch engine like obscura, or a hosted
    browser cloud.

- ed33aab: Tool failures: typed error channel, one failure envelope.
  - `Tool` gains a typed error parameter (`Tool<Name, Input, Event, Output, E, R>`), inferred by `Tool.make` from `run`. `Tool.fail(message, { kind? })` and the `ToolFailed` sentinel let a tool speak a failure to the model deliberately.
  - `Toolkit.run` absorbs `string` / `ToolFailed` failures into `ToolResult.Failure` (the model reads and adapts to them) and propagates every other tool error typed on its stream (`Exclude<ToolkitE<T>, string | ToolFailed>`); defects die. `Toolkit.describeFailures(describe)` opts a toolkit's failures into model visibility by mapping them to strings.
  - Input decoding is shared and hardened: empty arguments normalize to `{}`, a throwing validator is captured, unparseable or invalid arguments come back as an `input_validation_error` result carrying the issue detail, and tool lookup is own-property only.
  - Wire format: successful string outputs pass through raw; failures render as `{"error":{"kind","message"}}`; a `run` returning nothing serializes to `"null"`.
  - Canonical tools are bare: `webSearchTool` and `webReadTool` return the rendered string as their `Output` and fail with `AiError` on the typed channel.
  - `Approval.fromQueue` takes an optional `timeout` (unanswered gated calls resolve as `cancelled`) and its router retires once a round is fully resolved instead of running forever.

  Breaking: `run`'s error channel goes from `unknown` to a typed `E`, so code that wrote out a full `Tool<...>` type annotation must add the `E` parameter before `R`. Tools built with `Tool.make` infer `E` from `run` and need no change. See the [0.10 migration guide](https://effect-uai.betalyra.com/migrations/v0-10/).

- 98ee12c: New `WebRead` capability (additive). Turn a URL into clean markdown or HTML,
  then extract typed data from it. It mirrors `WebSearch`: one generic tag,
  several provider layers, and a ready-made tool.
  - **`@effect-uai/core/WebRead`**: the generic `WebRead` tag and `read(request)`
    helper. A request is `{ url, format?, timeout? }`; a response is
    `{ url, content, title?, links?, raw }`. Every implementor answers `read`,
    so the capability needs no marker tags.
  - **`@effect-uai/core/WebReadTool`**: `webReadTool(options?)` hands the
    capability to a model as a tool, the same way `webSearchTool` does for
    search. `Output` is the rendered string; it fails with `AiError`.
  - Four providers register the generic `WebRead` tag, swappable as a Layer:
    `@effect-uai/firecrawl` (new package, JS-rendered pages),
    `@effect-uai/exa/ExaContents`, `@effect-uai/tavily/TavilyRead`, and
    `@effect-uai/jina/JinaReader`.

## 0.9.0

### Minor Changes

- a56e470: New streaming metrics, with OTLP export (breaking: the old generic helpers
  are replaced).
  - **`@effect-uai/core/Metrics`**: small operators you stack onto a turn (or a
    whole loop) that emit typed `MetricEvent`s alongside the model's own
    events, at their own cadence. `timeToFirstToken`, `throughput` (windowed /
    cumulative, optional EWMA smoothing, char / token / event units with an
    optional tokenizer), `tokenTotals` (this turn's `usage` plus the
    `cumulative` total), and `timeToCompletion`. `allMetrics(options?)` stacks
    all four; `isMetricEvent` separates them from `TurnEvent`s downstream;
    `makeEvent` mints your own custom metric event.
  - **`@effect-uai/core/Telemetry`**: `record(options?)` records the same
    events (built-in and custom) into Effect `Metric` instruments;
    `layerOtlp(options)` ships them to an OTLP endpoint, leaving the
    `HttpClient` to your runtime.
  - **Removed:** the old generic stream helpers `Metrics.withElapsed`,
    `Metrics.timeToFirst`, and `Metrics.withRate`. The new turn-aware operators
    replace them.

  See [Migrating to 0.9](https://effect-uai.betalyra.com/migrations/v0-9/) and
  the [Metrics](https://effect-uai.betalyra.com/concepts/metrics/) concept page.

- a56e470: Tool layer rework (breaking, both changes mechanical at the call site):
  - **`Toolkit` is a name-indexed record.** Build it with
    `Toolkit.make(...tools)` (variadic, rejects a duplicate literal name at
    compile time) or `Toolkit.fromArray(tools)` for runtime-built sets (MCP,
    last-wins). `streamTurn`'s `tools?` and `Toolkit.run` take the toolkit
    directly and render wire descriptors at the provider boundary, so the
    `Tool.toDescriptors([...])` call at the request site is gone.
    `Toolkit.descriptors(toolkit)` still returns the `ToolDescriptor[]` if you
    want it.
  - **Plain and streaming tools unify into one `Tool.make`.** `run(input, emit)`
    returns the model-facing `Output` as an `Effect` and calls `emit(event)`
    for progress; fold events into the output inside `run`. `Tool.streaming`,
    `StreamingTool`, `isStreamingTool`, `AnyStreamingTool`, `AnyPlainTool`, and
    `finalize` are removed. The `Tool` type gains an `Event` parameter:
    `Tool<Name, Input, Event, Output, R>`.
  - **Honest tool kinds, discriminated by `_tag`:** `Tool.make` (local),
    `Tool.provider` (provider-hosted, rendered natively), `Tool.signal` and
    `Tool.interaction` (decode-only control tools the loop intercepts). Faked
    control tools (`run: () => Effect.succeed(...)`) become `Tool.signal` /
    `Tool.interaction`; keep `Tool.decodeArgs`, drop the fake `run`.
  - **Compose toolkits from independent sources:** `Toolkit.compose(...kits)`
    fails with `DuplicateToolName` on a cross-source collision instead of
    silently overwriting; `Toolkit.namespace(prefix, kit)` /
    `Toolkit.makeNamespaced(prefix, ...tools)` prefix generic names;
    `Toolkit.wrap(middleware)` wraps every local tool's `run`.
  - **Sharper failures:** input-schema validation now fails with
    `Tool.ToolValidationError` and surfaces as `ToolResult.Failure` kind
    `"input_validation_error"` (was `"execution_error"`); a non-local kind
    passed to `Toolkit.run` yields kind `"non_local_tool"`.

  See [Migrating to 0.9](https://effect-uai.betalyra.com/migrations/v0-9/).

## 0.8.0

### Minor Changes

- 842d92b: New `WebSearch` capability (additive):
  - **`@effect-uai/core/WebSearch`**: a generic `WebSearch` service for
    searching the live web, with a free `search` helper (resolve the tag,
    call `.search`). `CommonSearchRequest` is the cross-provider request
    intersection (`query`, `maxResults`, `recency`, `startDate` / `endDate`
    as `DateTime`, `includeDomains` / `excludeDomains`, `country`,
    `language`); `SearchResponse` carries normalized `SearchResult`s
    (`url`, `title`, `snippet`, `publishedDate`, `score`) plus the raw
    provider payload. `SearchRecency` is `"hour" | "day" | "week" | "month"
| "year"`. A provider `layer` registers both the generic `WebSearch` tag
    and its provider-typed tag at once.
  - **`@effect-uai/core/WebSearchTool`**: `webSearchTool(options?)` builds a
    ready-to-use tool for the agent loop. The model only chooses `query`
    (and optional `recency`); app policy (`maxResults`, `includeDomains` /
    `excludeDomains`, result rendering) lives in the constructor, not the
    model arguments. The tool annotates a `web_search` client span.

  See [Migrating to 0.8](https://effect-uai.betalyra.com/migrations/v0-8/).

- 842d92b: 0.8 adds web search. A new `WebSearch` capability lands in core: a generic
  service for "search the live web" that providers register against, a free
  `search` helper, and a `webSearchTool` you hand to the agent loop so the
  model can ground its answers in current results. Three search providers
  debut behind it (`@effect-uai/perplexity`, `@effect-uai/exa`,
  `@effect-uai/tavily`), and two recipes show the patterns end to end:
  [grounded answer](https://effect-uai.betalyra.com/recipes/grounded-answer/)
  (search, read, cite) and
  [deep research](https://effect-uai.betalyra.com/recipes/deep-research/)
  (plan, fan out parallel sub-agents, synthesize a cited report).

  Like the request shape on every other capability, `CommonSearchRequest`
  is the cross-provider intersection (`query`, `maxResults`, `recency`,
  date range, `includeDomains` / `excludeDomains`, `country`, `language`);
  each provider maps what it supports and `warnDropped`s the rest instead
  of silently changing your query. Cost reporting is deliberately left off
  `SearchResponse` for now, deferred to a unified usage-tracking pass.

  **Purely additive. No migration needed.** Bump dependencies, run
  typecheck, done. The new surface is in
  [Migrating to 0.8](https://effect-uai.betalyra.com/migrations/v0-8/).

  Every package outside core and the three new search providers
  (`@effect-uai/responses`, `@effect-uai/anthropic`, `@effect-uai/google`,
  `@effect-uai/jina`, `@effect-uai/openai`, `@effect-uai/elevenlabs`,
  `@effect-uai/inworld`, `@effect-uai/microsandbox`, `@effect-uai/deno`)
  has no functional changes this release; they bump for lockstep versioning
  only.

## 0.7.0

### Minor Changes

- 602bfa9: 0.7 is a capability-honesty pass across every audio and embedding
  surface. The unifying rule: where a provider cannot honor a request, the
  call now fails with `AiError.Unsupported` (load-bearing gaps) or emits a
  structured `warnDropped` (best-effort hints), instead of silently
  substituting a different result. Alongside that, `Duration` replaces raw
  `durationSeconds` everywhere audio carries a length, the `MusicGenerator`
  surface is reshaped, an ElevenLabs music provider lands, and Gemini
  `toolChoice` is now mapped.

  Most of it is mechanical (find-and-replace renames plus a
  `Duration.seconds(n)` wrap). The parts that need judgement are the
  removed `GeminiTranscriber` (use OpenAI / ElevenLabs / Inworld instead)
  and the requests that now error where they previously degraded silently.
  The full before/after diffs and the recommended order live in
  [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).

  `@effect-uai/anthropic`, `@effect-uai/microsandbox`, and
  `@effect-uai/deno` have no functional changes this release; they bump for
  lockstep versioning only.

- 602bfa9: Core domain and service reshape (audio, STT, TTS, embeddings):
  - **Audio**: `AudioBlob.durationSeconds: number` becomes
    `duration?: Duration.Duration`. The same rename flows through
    `TranscriptResult` (STT) and `MusicResult` (music).
  - **Transcriber**: `CommonTranscribeRequest.prompt` splits into
    `prompt?: string` (free-form prose context) and
    `biasingTerms?: ReadonlyArray<string>` (discrete vocabulary). The old
    `{ terms }` union arm is gone. `TranscriptResult.durationSeconds`
    becomes `duration`. Stream `inputFormat` gaps now fail
    `AiError.Unsupported` instead of `InvalidRequest`.
  - **SpeechSynthesizer**: `PhoneticEncoding` and
    `CustomPronunciation.encoding` are removed (`pronunciation` is IPA-only).
    Pronunciations are load-bearing: a provider with no IPA path fails
    `Unsupported` rather than dropping them. `DialogueTurn` trims to
    `{ voiceId, text }` (`styleDescription` / `speed` removed).
  - **MusicGenerator**: `prompts` becomes `prompt` (string), `bpm` / `scale`
    / `instrumental` dropped from `CommonGenerateMusicRequest`, `MusicResult`
    composes `AudioBlob` (`result.audio.bytes`), `generate` returns
    `GenerateResult` (`primary` + `variants[]`), `streamGenerationFrom`
    yields `MusicStreamEvent`, and `MusicSessionInput` drops the `config`
    variant.
  - **EmbeddingModel**: `EmbedEncoding` is trimmed to
    `"float32" | "int8" | "binary"` (the dense cross-provider request set);
    `sparse` / `multivector` move to the provider-typed `JinaEncoding`. New
    `ResponseEncoding` (the wider response union) parameterizes
    `EmbedResponse<E>` / `EmbedManyResponse<E>`. New exported `assertEncoding`
    guard validates an encoding against a provider's supported set and fails
    `Unsupported` instead of returning a mislabeled vector.
  - **Additive**: new `@effect-uai/core/Capabilities` module with
    `warnDroppedWhen` for structured bucket-2 warn-and-drop.

  See [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).

## 0.6.0

### Minor Changes

- a332f0a: 0.6 bundles one large-but-mechanical naming sweep with a set of
  additive features. The breaking part is source-level only — **the wire
  format is unchanged** (`function_call` / `function_call_output` still
  go out on the wire, so no provider payloads change). Almost every
  rewrite is find-and-replace; the full before/after diffs and the
  recommended order live in [Migrating to 0.6](https://effect-uai.betalyra.com/migrations/v0-6/).

  ### Breaking: "function call" → "tool call" terminology

  Every public name that said "function call" now says "tool call":
  - `Item` → `HistoryItem`; `FunctionCall` → `ToolCall`;
    `FunctionCallOutput` → `ToolCallOutput`.
  - `Items.functionCallOutput` → `Items.toolCallOutput`;
    `Items.isFunctionCall` → `Items.isToolCall`;
    `Items.isFunctionCallOutput` → `Items.isToolCallOutput`.
  - `Turn.functionCalls` → `Turn.getToolCalls`.

  ### Breaking: module renames
  - `@effect-uai/core/Outcome` → `@effect-uai/core/ToolResult`. Also
    `ToolResult.Value` → `ToolResult.Ok`, `isValue` → `isOk`,
    `rejected(...)` → `failed(...)`, `toFunctionCallOutput` →
    `toToolCallOutput`.
  - `@effect-uai/core/Resolvers` → `@effect-uai/core/Approval`. Also
    `fromApprovalMap` → `fromMap`, `fromVerdictQueue` → `fromQueue`,
    `ToolCallDecision` → `ApprovalDecision`, and the queue helper's
    `announce` field → `approvalRequests`.

  ### Breaking: Turn / Toolkit / Tool / ToolEvent renames
  - `Turn.appendTurn` → `Turn.appendToHistory`.
  - `Turn.toStructured` → `Turn.decodeStructured`.
  - `Toolkit.executeAll` → `Toolkit.run`.
  - `Toolkit.continueWith` → `Toolkit.continueWithResults`.
  - `Toolkit.make(...)` + `Toolkit.toDescriptors(kit)` → just
    `Tool.toDescriptors([...])`. The homogeneous-toolkit wrapper is gone.
  - `Tool.AnyKindTool` → `Tool.AnyTool`.
  - `ToolEvent.Intermediate` → `ToolEvent.Progress`;
    `isIntermediate` → `isProgress`.

  ### Breaking: Loop helper trim
  - `Loop.loopFrom(...)` → `Loop.loopOver(...)`.
  - `Loop.Event<A, S>` → `Loop.Step<A, S>`.
  - `return stop` → `return stop()`.
  - `Loop.stopWith(state)` → `Loop.stop(state)`.
  - `nextAfter` / `stopAfter` / `stopWithAfter` / `stopEvent` /
    `nextAfterFold` are removed — compose with `Stream.concat` instead.
    See the migration doc for one-line replacements.

  ### Additive: new Toolkit / Loop helpers
  - `Toolkit.appendToolResults(state, turn)` — shorthand for the canonical
    `continueWithResults` body that folds tool results into history.
  - `Toolkit.collectResults` — lower-level drain of a `Stream<ToolEvent>`
    to its `ToolResult`s without advancing the loop.

  ### Additive: sandboxes

  A new `Sandbox` capability in `@effect-uai/core/sandbox` for running
  untrusted code, commands, or LLM-generated scripts inside an isolated
  microVM. Two new provider packages ship behind the same
  `SandboxService`:
  - **`@effect-uai/microsandbox`** — local Firecracker microVMs via
    [microsandbox](https://github.com/microsandbox/microsandbox).
  - **`@effect-uai/deno`** — hosted Firecracker microVMs on
    [Deno Deploy](https://docs.deno.com/deploy/).

  Both cover `create` / `exec` / `execStream` / volumes / snapshots /
  network policies / bound secrets / OCI image references. The
  `recipes-extras/sandbox-code-interpreter` recipe shows the "run, fix,
  repeat" pattern.

  ### Additive: new recipes
  - `sleeper-agent` — long-lived background agent waking on scheduled
    triggers.
  - `sandbox-code-interpreter` (in `recipes-extras/`) — agent writes
    Python, sandbox runs it, stderr feeds back into the next turn.

- a332f0a: Multi-speaker dialogue + custom pronunciations on `SpeechSynthesizer`:
  - New optional `pronunciations?: ReadonlyArray<CustomPronunciation>` on
    `CommonSynthesizeRequest`. New types `PhoneticEncoding`
    (`"ipa" | "x-sampa" | "cmu-arpabet"`) and `CustomPronunciation`
    (`{phrase, pronunciation, encoding}`). Adapters that can't honor an
    entry silently drop it; audio still renders with the default
    pronunciation.
  - New methods `synthesizeDialogue` and `streamSynthesizeDialogue` on
    `SpeechSynthesizerService`, taking `CommonSynthesizeDialogueRequest`
    (`{model, turns, outputFormat?, languageCode?, pronunciations?}`).
    `DialogueTurn` is `{voiceId, text, styleDescription?, speed?}`.
  - New capability marker `MultiSpeakerTts` — shipped only by provider
    Layers with native dialogue support. Top-level helpers
    `synthesizeDialogue` / `streamSynthesizeDialogue` require it in `R`,
    so providers without dialogue support fail at compile time. Mirrors
    the existing `TtsIncrementalText` pattern.
  - `MockSpeechSynthesizer` extended with `dialogueBlobs` and
    `streamSynthesizeDialogueChunks` script fields plus a new
    `layerWithoutMultiSpeaker` variant for testing the marker.

  Non-breaking: every existing call site continues to compile.

## 0.5.2

### Patch Changes

- 1509883: Two related refactors. Both are breaking but mechanical — a one-line
  rewrite per affected call site.

  ### `Retry` is its own module

  `LanguageModel.retry` and `LanguageModel.Retryable` were not
  LanguageModel-specific — the implementation was a generic `AiError`
  combinator. Hoisted out into `@effect-uai/core/Retry`, with two
  carriers so it covers every model surface:
  - `Retry.stream(schedule)` — for `Stream<A, AiError, R>` (`streamTurn`,
    `streamSynthesis`, `streamTranscriptionFrom`).
  - `Retry.effect(schedule)` — for `Effect<A, AiError, R>` (`turn`,
    `embed`, `embedMany`, `synthesize`, `transcribe`).

  Both gate on the `RateLimited | Unavailable | Timeout` subset; other
  `AiError`s propagate unchanged. The namespace deliberately doesn't
  shadow Effect's own `Stream.retry` / `Effect.retry`.

  ```ts
  // Before
  import { retry } from "@effect-uai/core/LanguageModel"
  streamTurn(req).pipe(retry(schedule))

  // After
  import * as Retry from "@effect-uai/core/Retry"
  streamTurn(req).pipe(Retry.stream(schedule))
  embed(req).pipe(Retry.effect(schedule))
  ```

  `Retryable` and `isRetryable` move to the same module.

  ### `turn` is now on `LanguageModelService`

  `turn(request): Effect<Turn, AiError>` is now a method on the service
  alongside `streamTurn`. Providers without a native non-streaming
  endpoint derive it from `streamTurn` via the new
  `LanguageModel.turnFromStream(streamTurn)` helper; providers with a
  native complete endpoint can override.

  The top-level `LanguageModel.turn(request)` helper is unchanged at
  call sites — it now delegates to the service method instead of
  draining `streamTurn` inline.

  Hand-rolled `LanguageModelService` values (most commonly in tests)
  must now supply a `turn` field. Use `turnFromStream`:

  ```ts
  // Before
  const service: LanguageModelService = {
    streamTurn: () => Stream.fromIterable([...]),
  }

  // After
  import { turnFromStream } from "@effect-uai/core/LanguageModel"
  const streamTurn: LanguageModelService["streamTurn"] = () => Stream.fromIterable([...])
  const service: LanguageModelService = { streamTurn, turn: turnFromStream(streamTurn) }
  ```

## 0.5.1

### Patch Changes

- 4d83b13: The bare `effect-uai` name-squat package now ships in lockstep with
  every `@effect-uai/*` scoped package via changesets' `fixed` group —
  no more drift between the placeholder and the real packages. No
  functional changes in this release; the package remains a name
  reservation, install [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core)
  and the provider packages.

## 0.5.0

### Minor Changes

- `TurnEvent` migrated to `Data.TaggedEnum`. Discriminator renamed from
  `type` → `_tag`; variants PascalCased (`text_delta` → `TextDelta`,
  `reasoning_delta` → `ReasoningDelta`, `refusal_delta` → `RefusalDelta`,
  `tool_call_start` → `ToolCallStart`, `tool_call_args_delta` →
  `ToolCallArgsDelta`, `usage_update` → `UsageUpdate`, `turn_complete` →
  `TurnComplete`). Use `TurnEvent.TextDelta({...})` constructors plus
  `TurnEvent.$is` / `TurnEvent.$match`. `Turn.isTurnComplete` unchanged.
- `ToolCallDecision` migrated to `Data.TaggedEnum`. `Resolvers.approve` /
  `reject` helpers unchanged; can also construct via
  `ToolCallDecision.Approved({...})` / `Rejected({...})`.
- Removed `Toolkit.outputEvent(result)` / `Toolkit.outputEvents(results)`.
  Use `ToolEvent.Output({ result })` directly, or
  `Stream.fromIterable(results.map((result) => ToolEvent.Output({ result })))`
  for the batch form.
- Renamed `Encoding` → `EmbedEncoding` on `EmbeddingModel`. Avoids the clash
  with Effect's own `Encoding` module that bit everyone who imported both.
- `EmbedResponse` / `EmbedManyResponse` are now generic over the request's
  `encoding` field via the new `EmbeddingFor<E>` helper.
  `embed({ encoding: "float32" })` returns `EmbedResponse<"float32">` with
  `embedding: Float32Embedding` — no runtime narrowing for the common case.
  The bare `EmbedResponse` name still works (defaults to `Float32Embedding`).
- New `Loop.stopWith(state)` / `Loop.stopWithAfter(stream, state)` — terminal
  event that ends the loop AND carries final state. `loopFrom` threads it to
  the next input; `loopWithState` writes it to the `SubscriptionRef` before
  ending. Plain `loop` treats it like `stop`. The `Event.StopWith` variant
  joins `Value` / `Next` / `Stop`.
- New `Loop.loopFrom(input, initial, body)` — input-driven sibling of `loop`.
  For each item pulled from `input`, runs an inner seed-driven `loop` with
  `(s) => body(s, item)`. State threads across input items via `next` /
  `stopWith`. Outer termination = the input stream ending. The natural shape
  for "stream of documents, multi-turn conversation per document."
- `Loop.nextAfter` / `Loop.nextAfterFold` / `Loop.onTurnComplete` are now
  `Function.dual` — data-first `nextAfter(stream, state)` and data-last
  `stream.pipe(nextAfter(state))` both work.
- New `LanguageModel.turn(request)` — drains `streamTurn` and returns the
  assembled `Turn` from the terminal `TurnComplete` event. Fails with
  `IncompleteTurn` if absent. Derived; providers get it for free.
- New `LanguageModel.retry(schedule)` + `LanguageModel.Retryable` — stream
  combinator that retries only the retryable subset of `AiError`
  (`RateLimited` / `Unavailable` / `Timeout`); other failures bypass the
  schedule and propagate unchanged.
- New `Turn.assistantText(turn)` / `Turn.assistantTexts(turn)` — concatenated
  string / per-message array of `output_text` payloads. The common shape for
  summarizers, classifiers, and structured-output backstops.
- New `Tool.fromStandardSchema(schema)` — adapt any schema library that
  implements both Standard Schema and Standard JSON Schema (Zod 4.2+,
  Valibot 1.2+, ArkType 2.1.28+) as a tool input schema. Effect Schema users
  keep `fromEffectSchema`.
- New `StructuredFormat.decodeJsonLinesRecoverable(format)` — variant of
  `decodeJsonLines` that yields `Result<A, JsonParseError | StructuredDecodeError>`
  per line instead of failing the stream on the first bad frame. Use for
  log-and-continue or partial-recovery flows.
- `MockProvider` refactored to a functional pipeline. `layer`,
  `layerWithRecorder`, and `make` now share one `buildService` and route
  scripted turns through declarative `Match.discriminators` + `flatMap`.
  Public API unchanged.
- Internal: every `JSON.parse` + `Effect.try` site swapped for
  `Schema.decodeUnknownEffect(Schema.fromJsonString(...))`. No behavior
  change for callers.

## 0.4.0

### Minor Changes

- 70c8522: Add STT and TTS

## 0.4.0

### Minor Changes

- New speech services — `Transcriber` (STT), `SpeechSynthesizer` (TTS), and
  `MusicGenerator` siblings of `LanguageModel` / `EmbeddingModel`. Each
  exposes sync (`transcribe` / `synthesize` / `generate`) and stream
  (`streamTranscriptionFrom` / `streamSynthesisFrom`) shapes. Streaming
  variants take a `Stream<Uint8Array>` (mic frames) or `Stream<string>`
  (incremental text) and return a `Stream` of typed events, so live audio
  composes with the rest of Effect (`Stream.run*`, `Stream.merge`, scoped
  resources).
- New shared media domain — `@effect-uai/core/Audio` (PCM / container
  formats, `AudioChunk`, `AudioSource`), `@effect-uai/core/Transcript`
  (`TranscriptEvent` tagged union: `partial` / `final` /
  `speech-started` / `speech-stopped` / `usage`), and
  `@effect-uai/core/Music` (`MusicChunk`, generation request shape).
- Provider-fit markers — `SttStreaming` and `TtsIncrementalText` tags
  let callers (and recipes like Voice Loop, Streaming transcription)
  refuse a sync-only provider at the type level instead of failing at
  runtime.
- New `EmbeddingModel` service — parallel of `LanguageModel` for vectorization.
  Adds `@effect-uai/core/EmbeddingModel` (service tag, `embed` / `embedMany`,
  `CommonEmbedRequest`, cross-provider `Encoding` union) and
  `@effect-uai/core/Embedding` (tagged union of `Float32` / `Int8` / `Binary` /
  `Sparse` / `Multivector` embeddings with predicates, plus `EmbedInput` and
  `Usage`).
- New `@effect-uai/core/Vector` math primitives: dense (`cosine`, `dot`,
  `l2Norm`, `normalize`, `euclidean`), sparse (`sparseCosine`, `sparseDot`,
  `sparseL2Norm`), and multivector (`maxSim`).
- New media domain shared with language-model multimodal inputs:
  `@effect-uai/core/Media` (generic `MediaSource<MimeType>`) and
  `@effect-uai/core/Image` (typed `ImageMimeType` plus `imageUrl` /
  `imageBase64` / `imageBytes` constructors and predicates).
- Removed `@effect-uai/core/Match` and the `matchType` helper. Migrate to
  `Match.discriminators("type")({...})` (or `discriminatorsExhaustive`)
  from `effect`.
- `ToolResult`, `ToolEvent`, and `Image*Source` migrated to
  `Data.TaggedEnum` — you now get `.$is`, `.$match`, and constructors like
  `ToolResult.Failure({...})` / `ToolEvent.Output({...})`. The `_tag` wire
  shape and existing `is*` predicates are preserved.
- New barrel re-exports from `@effect-uai/core`: `Outcome`, `ToolEvent`,
  `Resolvers`, `HistoryCheck`.
- Tools can now declare an `R` requirement and receive Effect services in
  `run`. `Tool.AnyPlainTool` / `Tool.AnyStreamingTool` / `Tool.AnyKindTool`
  are generic over `R` (default `any`); `Toolkit.executeAll` propagates the
  union via the new `Toolkit.ToolKindR<Tools>` helper. Provide services with
  `Effect.provide` at the recipe level — same compile-time guarantee as
  every other Effect service, no parallel `toolsContext` mechanism.
- Renamed `Loop.streamUntilComplete` → `Loop.onTurnComplete`. Same
  semantics — runs a continuation when the `turn_complete` sentinel
  arrives. Old name is gone.
- Renamed and curried `Toolkit.nextStateFrom` → `Toolkit.continueWith`.
  Now dual via `Function.dual`: data-first
  `Toolkit.continueWith(stream, build)` and pipe-friendly
  `stream.pipe(Toolkit.continueWith(build))` both work.
- New `Loop.loopWithState(initial, body)` — like `loop`, but returns
  `Effect<{ stream, state: SubscriptionRef<S> }>`. The ref is seeded with
  `initial` and updated on every `next(s)`. Use it for final-state
  inspection after `Stream.runDrain`, live observation via
  `SubscriptionRef.changes`, or mid-iteration peeks. Doesn't pollute the
  value stream.

## 0.3.0

### Minor Changes

- 1d33c63: Embeddings and simplifications
  - Adds embeddings
  - Rename core primitives to simplify DX
  - Add loopWithState
  - General improvements

## 0.2.0

### Minor Changes

- Tool approval moves out of the executor. `Toolkit.executeAll(tools, calls)`
  now only runs the calls you pass it; `Resolver`, `executeAllWithResolver`,
  `withPermissions`, and `withFallback` are removed. Recipes call the new
  planners (below) before `executeAll` and merge any rejected results into
  the event stream themselves. The pre-execution `ToolDecision` /
  `execute` / `reject` constructors in `Outcome` are gone with it.
- `Resolvers` reshaped around two planners that return data, not effects:
  - `fromApprovalMap(predicate, approvals)(calls)` returns a `ToolCallPlan`
    (`{ approved, rejected }`) synchronously.
  - `fromVerdictQueue(predicate, queue)(calls)` returns
    `{ approved, decisions, announce }` — `approved` runs immediately,
    `decisions` streams `ToolCallDecision`s as verdicts arrive, `announce`
    surfaces `ApprovalRequested` events for the UI.
  - New helpers: `ToolCallPlan`, `ToolCallDecision`, `approve`, `reject`,
    `splitToolCallDecisions`, `approvalRequested`.
- New `Toolkit.outputEvent(result)` / `Toolkit.outputEvents(results)` for
  turning rejected tool results back into `ToolEvent.Output`s when merging
  with `Toolkit.executeAll`.
- `Turn.appendTurn(state, turn, items?)` replaces the `Cursor<S>` / `cursor`
  pair. State advancement is now a single helper that appends `turn.items`
  plus any follow-up items (typically tool outputs) to `state.history` —
  no intermediate stamped wrapper.
