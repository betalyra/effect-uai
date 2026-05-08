# @effect-uai/jina

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
