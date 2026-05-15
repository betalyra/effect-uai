# @effect-uai/core

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
