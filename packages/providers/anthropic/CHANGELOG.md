# @effect-uai/anthropic

## 0.3.0

### Minor Changes

- 1d33c63: Embeddings and simplifications
  - Adds embeddings
  - Rename core primitives to simplify DX
  - Add loopWithState
  - General improvements

## Unreleased

### Patch Changes

- Updated dependencies for `@effect-uai/core` (new embedding subsystem;
  `Match` module / `matchType` helper removed; `Loop.streamUntilComplete`
  renamed to `Loop.onTurnComplete`; `Toolkit.nextStateFrom` renamed to
  `Toolkit.continueWith` and now pipe-friendly — see core changelog).
  No source changes; Anthropic does not currently ship an embedding API.

## 0.2.0

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.2.0` (tool-approval and
  state-advancement APIs reshaped — see core changelog). No source changes
  in this package.
  - @effect-uai/core@0.2.0
