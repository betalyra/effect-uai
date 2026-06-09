# @effect-uai/core

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
  import { retry } from "@effect-uai/core/LanguageModel";
  streamTurn(req).pipe(retry(schedule));

  // After
  import * as Retry from "@effect-uai/core/Retry";
  streamTurn(req).pipe(Retry.stream(schedule));
  embed(req).pipe(Retry.effect(schedule));
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
