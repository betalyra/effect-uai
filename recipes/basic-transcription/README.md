---
title: Basic transcription
description: "Transcribe an audio file with OpenAI STT: `gpt-4o-transcribe` for speed, `whisper-1` with per-word timestamps for rich output."
---

Transcribe an audio file with OpenAI's speech-to-text models.

Two variants:

- `transcribeGpt4o` — `gpt-4o-transcribe`, fast, text-only.
- `transcribeWhisperVerbose` — `whisper-1` with `wordTimestamps: true` for per-word `WordTimestamp[]`. OpenAI's GPT-4o transcribe models don't return per-word timing; the adapter enforces this with `AiError.Unsupported` if you combine `wordTimestamps: true` with a GPT-4o model.

`streamTranscriptionFrom` (live mic → transcript over WebSocket) is **not** demonstrated here yet — Phase 1 ships only the sync REST path. The `@effect-uai/openai-speech` Layer therefore omits the `SttStreaming` capability marker, and `Transcriber.streamTranscriptionFrom` against it is a compile-time error. Realtime WS lands in a Phase 1 follow-up.

## Run

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-transcription/run-node.ts path/to/audio.wav
```

Audio formats supported by OpenAI: `m4a`, `mp3`, `mp4`, `mpeg`, `mpga`, `oga`, `ogg`, `wav`, `webm`.
