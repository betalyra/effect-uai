# @effect-uai/elevenlabs

## 0.4.0

### Minor Changes

- Initial release. ElevenLabs speech provider package.
- `@effect-uai/elevenlabs/ElevenLabsSynthesizer` — TTS layer for the
  generic `SpeechSynthesizer` service. Sync `synthesize` plus
  `streamSynthesisFrom` for incremental text-in over the streaming
  WebSocket; registers `TtsIncrementalText` so callers can demand
  live-text TTS at the type level. PCM and container output formats.
- `@effect-uai/elevenlabs/ElevenLabsTranscriber` — STT layer for the
  generic `Transcriber` service. Sync `transcribe` plus
  `streamTranscriptionFrom` against Scribe v2 Realtime; registers
  `SttStreaming`. 16 kHz pcm16 input; partial + final transcript
  events with `speech-started` / `speech-stopped` boundaries.
