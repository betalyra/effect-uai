# @effect-uai/inworld

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
