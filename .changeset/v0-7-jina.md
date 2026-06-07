---
"@effect-uai/jina": minor
---

- **Embeddings (generic path)**: a scalar `int8` encoding now fails
  `AiError.Unsupported` via `assertEncoding`. Jina honors `float32` and
  `binary` (bit-quantized, packed into bytes), not scalar int8 per
  dimension. The provider-typed `JinaEmbedding` service still accepts
  `JinaEncoding` (`float32` / `binary` / `sparse` / `multivector`) on its
  own surface.
- **Multi-part input now fails `AiError.Unsupported`** (was
  `InvalidRequest`): Jina's flat `input[]` cannot fuse a multi-part
  `content[]` into one vector. Single-part text input is unchanged.

See [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).
