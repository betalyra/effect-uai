# @effect-uai/mistral

## 0.9.0

### Minor Changes

- a56e470: New provider `@effect-uai/mistral` (additive). One brand covering three
  capability surfaces:
  - **Language model**: Mistral chat models behind the generic `LanguageModel`
    tag.
  - **Speech to text**: Voxtral batch and realtime (streaming) transcription
    behind `Transcriber`.
  - **Text to speech**: Voxtral synthesis behind `SpeechSynthesizer`.

  Provide `mistral({ apiKey })` and your capability-tag code resolves, unchanged.
  Because all three surfaces share one brand, an entire STT to LLM to TTS
  pipeline can run on Mistral alone (the [Voice loop](https://effect-uai.betalyra.com/recipes/voice-loop/)
  recipe selects it with `--provider=mistral`).

  See [Migrating to 0.9](https://effect-uai.betalyra.com/migrations/v0-9/).
