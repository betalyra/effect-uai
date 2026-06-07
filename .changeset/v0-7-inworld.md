---
"@effect-uai/inworld": minor
---

- **`InworldTranscriber`**: `biasingTerms` maps to the Inworld `prompts`
  field; the free-form `prompt` `warnDropped`.
- **Realtime TTS**: `pronunciations` now fail `AiError.Unsupported` on the
  realtime path (no inline IPA there). The sync `InworldSynthesizer` still
  supports inline IPA pronunciations unchanged.

See [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).
