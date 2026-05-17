# @effect-uai/openai

## 0.5.0

### Minor Changes

- 084325a: Refactorings and api improvements.

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
