# @effect-uai/openai

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

- Initial release. OpenAI speech provider package, separate from the
  Responses API package (`@effect-uai/responses`).
- `@effect-uai/openai/OpenAISynthesizer` — TTS layer for the generic
  `SpeechSynthesizer` service. Sync `synthesize` only; OpenAI does not
  accept incremental text input.
- `@effect-uai/openai/OpenAITranscriber` — STT layer for the generic
  `Transcriber` service. Supports `gpt-4o-transcribe` (fast, text-only)
  and `whisper-1` (word timestamps via `wordTimestamps: true`).
- `@effect-uai/openai/OpenAIRealtimeTranscriber` — live STT over the
  OpenAI Realtime WebSocket. Registers the `SttStreaming` marker and
  exposes `streamTranscriptionFrom` for mic-to-transcript pipelines
  (24 kHz pcm16 input, partial + final transcript events).
