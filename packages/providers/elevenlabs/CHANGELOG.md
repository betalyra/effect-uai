# @effect-uai/elevenlabs

## 0.5.1

### Patch Changes

- 4d83b13: The bare `effect-uai` name-squat package now ships in lockstep with
  every `@effect-uai/*` scoped package via changesets' `fixed` group —
  no more drift between the placeholder and the real packages. No
  functional changes in this release; the package remains a name
  reservation, install [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core)
  and the provider packages.

## 0.5.0

### Patch Changes

- Updated dependencies for `@effect-uai/core@0.5.0` — see core changelog.
  No source changes; speech-only package.

## 0.4.0

### Minor Changes

- 70c8522: Add STT and TTS

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
