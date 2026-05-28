---
"@effect-uai/google": minor
---

- `GeminiSynthesizer` implements the new `SpeechSynthesizerService`
  dialogue methods (`synthesizeDialogue`, `streamSynthesizeDialogue`) —
  both fail with `AiError.Unsupported`. The Layer does NOT ship the
  `MultiSpeakerTts` marker, so callers using the top-level
  `synthesizeDialogue` helper get a compile-time error against this
  Layer alone. For Gemini-voice multi-speaker, use the upcoming
  `@effect-uai/google-speech` package with Cloud TTS.
- `pronunciations` on `CommonSynthesizeRequest` is silently ignored
  (Gemini API has no equivalent field).
