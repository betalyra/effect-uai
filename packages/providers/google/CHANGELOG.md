# @effect-uai/google

## 0.3.0

### Minor Changes

- 1d33c63: Embeddings and simplifications
  - Adds embeddings
  - Rename core primitives to simplify DX
  - Add loopWithState
  - General improvements

## Unreleased

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

## 0.2.0

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.2.0` (tool-approval and
  state-advancement APIs reshaped — see core changelog). No source changes
  in this package.
  - @effect-uai/core@0.2.0
