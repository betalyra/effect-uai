---
"@effect-uai/openai": minor
---

- `OpenAISynthesizer` implements the new `SpeechSynthesizerService`
  dialogue methods (`synthesizeDialogue`, `streamSynthesizeDialogue`) —
  both fail with `AiError.Unsupported`. The Layer does NOT ship the
  `MultiSpeakerTts` marker; multi-speaker calls fail at compile time.
- `pronunciations` on `CommonSynthesizeRequest` is silently ignored —
  OpenAI TTS has no phoneme override surface.
- Add optional `region` field to every `Config` (`OpenAISynthesizer`,
  `OpenAITranscriber`, `realtimeStt`). Typed union `OpenAiRegion = "default" |
  "eu" | (string & {})`; resolves to `eu.api.openai.com` for EU-residency
  projects. `baseUrl` continues to win when set; unknown region strings pass
  through as host prefixes (`{region}.api.openai.com/v1`) for forward compat.
  Each package exports a `resolveHost(cfg)` helper. Non-breaking.
