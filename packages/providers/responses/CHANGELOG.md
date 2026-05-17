# @effect-uai/responses

## 0.5.0

### Minor Changes

- `OpenAIEmbedding` returns the precise `EmbeddingFor<E>` variant on the
  generic `EmbeddingModel` path. OpenAI only emits `float32` at runtime;
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

- New `@effect-uai/responses/OpenAIEmbedding` sub-path: `OpenAIEmbedding`
  service tag, `layer`, `OpenAIEmbedRequest`, and `OpenAIEmbeddingModel`
  literal union. Text-only; Matryoshka via `dimensions`; `task` is omitted
  from the typed request (compile error) and ignored on the generic
  `EmbeddingModel` registration.

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
