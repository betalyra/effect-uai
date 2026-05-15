# @effect-uai/openai

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
