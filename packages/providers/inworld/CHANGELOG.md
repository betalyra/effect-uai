# @effect-uai/inworld

## 0.5.0

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.5.0` — see core changelog.
  No source changes; speech-only package.

## 0.4.0

### Minor Changes

- 70c8522: Add STT and TTS

## 0.4.0

### Minor Changes

- Initial release. Inworld speech provider package.
- `@effect-uai/inworld/InworldSynthesizer` — TTS layer for the generic
  `SpeechSynthesizer` service. Sync `synthesize` for finished text.
- `@effect-uai/inworld/InworldRealtimeSynthesizer` — incremental
  text-in TTS over WebSocket; registers `TtsIncrementalText`.
- `@effect-uai/inworld/InworldTranscriber` — STT layer for the generic
  `Transcriber` service. Sync `transcribe` for whole-file audio.
- `@effect-uai/inworld/InworldRealtimeTranscriber` — live STT over
  WebSocket; registers `SttStreaming` and emits partial + final
  transcript events.
