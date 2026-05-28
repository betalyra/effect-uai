---
"@effect-uai/elevenlabs": minor
---

- Wire `ElevenLabsSynthesizer` to the new core dialogue + pronunciation
  surface:
  - `synthesizeDialogue` → `POST /v1/text-to-dialogue` (raw audio bytes).
  - `streamSynthesizeDialogue` → `POST /v1/text-to-dialogue/stream`
    (chunked binary).
  - Layer now also registers the `MultiSpeakerTts` capability marker
    (alongside `TtsIncrementalText`). Per-turn `styleDescription` and
    `speed` are silently ignored — ElevenLabs `inputs[]` takes
    `{voice_id, text}` only.
  - `pronunciations` are applied as inline SSML `<phoneme alphabet="ipa|cmu-arpabet" ph="...">phrase</phoneme>`
    tags for the phoneme-gated legacy models (`eleven_flash_v2`,
    `eleven_english_v1`, `eleven_monolingual_v1`). Other models silently
    drop the overrides. `x-sampa` entries are always dropped.
- Add optional `region` field to every `Config` (`ElevenLabsSynthesizer`,
  `ElevenLabsTranscriber`, `realtimeTts`, `realtimeStt`). Typed union
  `ElevenLabsRegion = "default" | "eu" | "in" | (string & {})`; resolves to
  `api.{eu,in}.residency.elevenlabs.io` (REST + WSS). Reminder: ElevenLabs
  API keys are workspace-bound — pair an EU-workspace key with `region:
  "eu"`. `baseUrl` continues to win when set; unknown region strings pass
  through as residency host prefixes for forward compat. Exports a
  `resolveHost(cfg)` helper. Non-breaking.
