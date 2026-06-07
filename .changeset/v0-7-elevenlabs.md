---
"@effect-uai/elevenlabs": minor
---

- **New `@effect-uai/elevenlabs/ElevenLabsMusicGenerator`** (additive):
  ElevenLabs Music as a second `MusicGenerator` provider, with a typed
  extras surface (`compositionPlan` / `forceInstrumental` / `signWithC2pa`
  / `respectSectionsDurations`), a `createCompositionPlan` helper, and
  native chunked HTTP streaming. Does not register `MusicInteractiveSession`.
- **New `pronunciationDictionaryLocators`** (additive) on the synthesize
  request: reference a pre-provisioned ElevenLabs pronunciation dictionary
  by id.
- **Inline `pronunciations` now fail `AiError.Unsupported`** (ElevenLabs
  has no stateless inline IPA path). Use `pronunciationDictionaryLocators`
  instead.
- **`ElevenLabsTranscriber`**: `biasingTerms` maps to `keyterms`; `prompt`
  `warnDropped`.

See [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).
