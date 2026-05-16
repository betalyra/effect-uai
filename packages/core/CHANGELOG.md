# @effect-uai/core

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
