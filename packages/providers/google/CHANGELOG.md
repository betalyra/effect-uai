# @effect-uai/google

## 0.5.0

### Minor Changes

- Gemini now supports tool calling. `function_call` / `function_call_output`
  items round-trip via Gemini's `functionDeclarations` + `functionCall` /
  `functionResponse` parts. Gemini 3 wire ids are preserved across the
  round-trip via `FunctionCall.providerData.gemini.id`. Tool param schemas
  are sanitized to the OpenAPI 3.0 subset Gemini accepts (strips `$schema`,
  `$ref`, `$defs`, `additionalProperties`, `oneOf`).
- `GeminiEmbedding` returns the precise `EmbeddingFor<E>` variant on the
  generic `EmbeddingModel` path. Gemini only emits `float32` at runtime;
  callers asking for another encoding via the generic tag get the type they
  requested but the runtime value is still float32.
- Provider emitters now use `TurnEvent.TextDelta({...})` / `TurnEvent.ToolCallStart({...})`
  / etc. constructors. No wire-shape change for downstream consumers.

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.5.0` — see core changelog
  for `TurnEvent` tagged-enum migration, `Encoding` → `EmbedEncoding`
  rename, generic `EmbedResponse<E>`, removed `Toolkit.outputEvent` /
  `outputEvents`, new `Loop.stopWith` / `loopFrom`, `LanguageModel.turn` /
  `retry`, `Tool.fromStandardSchema`.

## 0.4.0

### Minor Changes

- 70c8522: Add STT and TTS

## 0.4.0

### Minor Changes

- New `@effect-uai/google/GeminiSynthesizer` and
  `@effect-uai/google/GeminiTranscriber` sub-paths — TTS and STT layers
  for the generic `SpeechSynthesizer` / `Transcriber` services. Both are
  sync-only; transcription is prompt-driven and text-only (no word
  timestamps), with 20 MB inline request cap.
- New `@effect-uai/google/LyriaGenerator` sub-path — music generation
  via Lyria, registered against the generic `MusicGenerator` service.
- New `@effect-uai/google/GeminiEmbedding` sub-path: `GeminiEmbedding`
  service tag, `layer`, `GeminiEmbedRequest`, `GoogleEmbeddingModel`
  (`gemini-embedding-2`, `gemini-embedding-001`), `GoogleEmbeddingTask`
  enum, and optional `title` for v1 retrieval-document tasks. Multimodal
  on v2; task field honoured on v1, ignored on v2. URL-form image inputs
  are rejected (use base64 or bytes).

### Patch Changes

- Updated dependencies for `@effect-uai/core` (new embedding subsystem;
  `Match` module / `matchType` helper removed; `Loop.streamUntilComplete`
  renamed to `Loop.onTurnComplete`; `Toolkit.nextStateFrom` renamed to
  `Toolkit.continueWith` and now pipe-friendly — see core changelog).

## 0.3.0

### Minor Changes

- 1d33c63: Embeddings and simplifications
  - Adds embeddings
  - Rename core primitives to simplify DX
  - Add loopWithState
  - General improvements

## 0.2.0

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.2.0` (tool-approval and
  state-advancement APIs reshaped — see core changelog). No source changes
  in this package.
  - @effect-uai/core@0.2.0
