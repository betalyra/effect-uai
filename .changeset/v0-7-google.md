---
"@effect-uai/google": minor
---

- **`GeminiTranscriber` is removed.** It rode on `:generateContent` (an
  LLM with a "transcribe" prompt), not a real STT endpoint, with no native
  word timestamps or diarization. `GeminiTranscriber`,
  `GeminiTranscribeRequest`, and `GeminiSttModel` are deleted. Use
  `@effect-uai/openai`, `@effect-uai/elevenlabs`, or `@effect-uai/inworld`
  for transcription.
- **Gemini `toolChoice` is now mapped** onto `functionCallingConfig`
  (`auto` to AUTO, `required` to ANY, `none` to NONE, a named function to
  ANY plus `allowedFunctionNames`). It was previously forced to AUTO and
  ignored.
- **Gemini `url`-source images now fail `AiError.Unsupported`** (Gemini
  needs them pre-uploaded via the Files API). They were silently dropped.
  Pass base64 or raw bytes instead.
- **`GeminiSynthesizer`**: `pronunciations` now fail `Unsupported` (no IPA
  path); `speed` and `languageCode` now `warnDropped` instead of vanishing
  silently.
- **`LyriaGenerator`**: returns `GenerateResult` with a composed
  `MusicResult`; `lyria-3-clip-preview` (fixed at mp3, no format wire
  field) now returns mp3 and reports `audio.format` honestly instead of
  rejecting `container: "wav"` with a per-model error.

See [Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).
