# @effect-uai/google

## Unreleased

### Minor Changes

- New `@effect-uai/google/GeminiEmbedding` sub-path: `GeminiEmbedding`
  service tag, `layer`, `GeminiEmbedRequest`, `GoogleEmbeddingModel`
  (`gemini-embedding-2`, `gemini-embedding-001`), `GoogleEmbeddingTask`
  enum, and optional `title` for v1 retrieval-document tasks. Multimodal
  on v2; task field honoured on v1, ignored on v2. URL-form image inputs
  are rejected (use base64 or bytes).

### Patch Changes

- Updated dependencies for `@effect-uai/core` (new embedding subsystem).

## 0.2.0

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.2.0` (tool-approval and
  state-advancement APIs reshaped — see core changelog). No source changes
  in this package.
  - @effect-uai/core@0.2.0
