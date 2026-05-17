# @effect-uai/jina

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

- `JinaEmbedding` returns the precise `EmbeddingFor<E>` variant — both on
  the typed `JinaEmbedding` tag and the generic `EmbeddingModel` tag.
  `embed({ encoding: "binary" })` now gives `embedding: BinaryEmbedding`
  directly; sparse / multivector ditto. No runtime narrowing for the common
  case. The cross-provider type on `CommonEmbedRequest` is now
  `EmbedEncoding` (was `Encoding`); the typed `JinaEncoding` is unchanged.

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.5.0` — see core changelog
  for `TurnEvent` tagged-enum migration, `Encoding` → `EmbedEncoding`
  rename, generic `EmbedResponse<E>`, removed `Toolkit.outputEvent` /
  `outputEvents`, new `Loop.stopWith` / `loopFrom`, `LanguageModel.turn` /
  `retry`, `Tool.fromStandardSchema`.

## 0.4.0

### Minor Changes

- 70c8522: Add STT and TTS

## 0.3.0

### Minor Changes

- 1d33c63: Embeddings and simplifications
  - Adds embeddings
  - Rename core primitives to simplify DX
  - Add loopWithState
  - General improvements

## Unreleased

First published release. Embedding-only Jina provider.

### Minor Changes

- `@effect-uai/jina/JinaEmbedding`: `JinaEmbedding` service tag, `layer`,
  `JinaEmbedRequest`, `JinaEmbeddingModel` (`jina-embeddings-v4`, v5
  small/nano, v3, `jina-clip-v2`), `JinaEncoding` (`float32` / `binary` /
  `sparse` / `multivector`), and `JinaTask` (`retrieval.query` /
  `retrieval.passage` / `text-matching` / `code.query` / `code.passage` /
  `classification` / `separation`).
- Multimodal text + image, sparse hybrid search (`elser-v2`), multivector
  late-interaction, and binary quantization. Encoding compatibility is
  validated at the response level — no hardcoded model-encoding table.

### Patch Changes

- Initial release; depends on `@effect-uai/core`.
