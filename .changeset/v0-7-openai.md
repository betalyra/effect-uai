---
"@effect-uai/openai": minor
---

- **`OpenAITranscriber`**: `diarization` is narrowed off
  `OpenAITranscribeRequest` (OpenAI has no diarization). The proactive
  per-model `wordTimestamps` guard is removed: a non-`whisper-1` model now
  surfaces the provider's wire 400 rather than a pre-send `Unsupported`.
  `prompt` maps to the OpenAI prompt field; `biasingTerms` `warnDropped`.
- **`OpenAISynthesizer`**: `pronunciations` now fail `AiError.Unsupported`
  (OpenAI has no phoneme field); `languageCode` now `warnDropped` (OpenAI
  auto-detects).
- **Embeddings (generic path)**: a non-`float32` `encoding` now fails
  `Unsupported` instead of returning a mislabeled float32 vector; image
  input now fails `Unsupported` (was `InvalidRequest`); `task` now
  `warnDropped`.

See [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).
