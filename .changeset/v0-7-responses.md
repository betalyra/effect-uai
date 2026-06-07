---
"@effect-uai/responses": minor
---

- **`OpenAIEmbedding`**: a non-`float32` `encoding` now fails
  `AiError.Unsupported` via `assertEncoding` instead of returning a
  mislabeled float32 vector; image input now fails `Unsupported` (was
  `InvalidRequest`); `task` now `warnDropped` (OpenAI embeddings have no
  task field).

See [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).
