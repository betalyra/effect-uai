---
"@effect-uai/core": minor
---

Core domain and service reshape (audio, STT, TTS, embeddings):

- **Audio**: `AudioBlob.durationSeconds: number` becomes
  `duration?: Duration.Duration`. The same rename flows through
  `TranscriptResult` (STT) and `MusicResult` (music).
- **Transcriber**: `CommonTranscribeRequest.prompt` splits into
  `prompt?: string` (free-form prose context) and
  `biasingTerms?: ReadonlyArray<string>` (discrete vocabulary). The old
  `{ terms }` union arm is gone. `TranscriptResult.durationSeconds`
  becomes `duration`. Stream `inputFormat` gaps now fail
  `AiError.Unsupported` instead of `InvalidRequest`.
- **SpeechSynthesizer**: `PhoneticEncoding` and
  `CustomPronunciation.encoding` are removed (`pronunciation` is IPA-only).
  Pronunciations are load-bearing: a provider with no IPA path fails
  `Unsupported` rather than dropping them. `DialogueTurn` trims to
  `{ voiceId, text }` (`styleDescription` / `speed` removed).
- **MusicGenerator**: `prompts` becomes `prompt` (string), `bpm` / `scale`
  / `instrumental` dropped from `CommonGenerateMusicRequest`, `MusicResult`
  composes `AudioBlob` (`result.audio.bytes`), `generate` returns
  `GenerateResult` (`primary` + `variants[]`), `streamGenerationFrom`
  yields `MusicStreamEvent`, and `MusicSessionInput` drops the `config`
  variant.
- **EmbeddingModel**: `EmbedEncoding` is trimmed to
  `"float32" | "int8" | "binary"` (the dense cross-provider request set);
  `sparse` / `multivector` move to the provider-typed `JinaEncoding`. New
  `ResponseEncoding` (the wider response union) parameterizes
  `EmbedResponse<E>` / `EmbedManyResponse<E>`. New exported `assertEncoding`
  guard validates an encoding against a provider's supported set and fails
  `Unsupported` instead of returning a mislabeled vector.
- **Additive**: new `@effect-uai/core/Capabilities` module with
  `warnDroppedWhen` for structured bucket-2 warn-and-drop.

See [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).
