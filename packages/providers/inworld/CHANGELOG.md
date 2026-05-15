# @effect-uai/inworld

## 0.3.0

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
