---
"@effect-uai/core": minor
---

Multi-speaker dialogue + custom pronunciations on `SpeechSynthesizer`:

- New optional `pronunciations?: ReadonlyArray<CustomPronunciation>` on
  `CommonSynthesizeRequest`. New types `PhoneticEncoding`
  (`"ipa" | "x-sampa" | "cmu-arpabet"`) and `CustomPronunciation`
  (`{phrase, pronunciation, encoding}`). Adapters that can't honor an
  entry silently drop it; audio still renders with the default
  pronunciation.
- New methods `synthesizeDialogue` and `streamSynthesizeDialogue` on
  `SpeechSynthesizerService`, taking `CommonSynthesizeDialogueRequest`
  (`{model, turns, outputFormat?, languageCode?, pronunciations?}`).
  `DialogueTurn` is `{voiceId, text, styleDescription?, speed?}`.
- New capability marker `MultiSpeakerTts` — shipped only by provider
  Layers with native dialogue support. Top-level helpers
  `synthesizeDialogue` / `streamSynthesizeDialogue` require it in `R`,
  so providers without dialogue support fail at compile time. Mirrors
  the existing `TtsIncrementalText` pattern.
- `MockSpeechSynthesizer` extended with `dialogueBlobs` and
  `streamSynthesizeDialogueChunks` script fields plus a new
  `layerWithoutMultiSpeaker` variant for testing the marker.

Non-breaking: every existing call site continues to compile.
