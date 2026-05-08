# @effect-uai/responses

## Unreleased

### Minor Changes

- New `@effect-uai/responses/OpenAIEmbedding` sub-path: `OpenAIEmbedding`
  service tag, `layer`, `OpenAIEmbedRequest`, and `OpenAIEmbeddingModel`
  literal union. Text-only; Matryoshka via `dimensions`; `task` is omitted
  from the typed request (compile error) and ignored on the generic
  `EmbeddingModel` registration.

### Patch Changes

- Updated dependencies for `@effect-uai/core` (new embedding subsystem).

## 0.2.0

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.2.0` (tool-approval and
  state-advancement APIs reshaped — see core changelog). No source changes
  in this package.
  - @effect-uai/core@0.2.0
