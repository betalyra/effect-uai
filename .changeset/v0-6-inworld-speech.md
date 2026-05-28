---
"@effect-uai/inworld": minor
---

- `InworldSynthesizer` implements the new `SpeechSynthesizerService`
  dialogue methods (`synthesizeDialogue`, `streamSynthesizeDialogue`) —
  both fail with `AiError.Unsupported`. The Layer does NOT ship the
  `MultiSpeakerTts` marker; multi-speaker calls fail at compile time.
- `pronunciations` on `CommonSynthesizeRequest` are applied as inline
  `/ipa/` tokens in `text` (Inworld's documented mechanism). Only `ipa`
  entries are honored; `x-sampa` and `cmu-arpabet` entries are silently
  dropped. English-only.
