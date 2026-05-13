---
title: Basic transcription
description: "Transcribe an audio file via the generic Transcriber service. Switch providers with `--provider openai|gemini`. `whisper-1` verbose mode (per-word timestamps) is OpenAI-only."
---

Transcribe an audio file via the generic `Transcriber` service. Provider is picked at the runner level via `--provider`; the recipe Effects (`index.ts`) are provider-agnostic.

Two variants:

- `transcribeFast(provider, audio)` — each provider's fast text-only model. Works for both providers.
- `transcribeVerbose(audio)` — `whisper-1` with `wordTimestamps: true`, returning per-word `WordTimestamp[]`. **OpenAI only** — Gemini's prompt-driven transcription has no structured per-word timing, so the runner skips this when `--provider gemini` is set. Attempting it against the Gemini Layer fails with `AiError.Unsupported`.

`streamTranscriptionFrom` (live mic → transcript) is **not** demonstrated here — both provider Layers omit the `SttStreaming` capability marker, so calls are a compile-time error. Cloud Speech-to-Text (`@effect-uai/google-cloud-speech`) and OpenAI Realtime will register the marker in their respective phases.

## Providers

| Provider           | Fast model                                          | Verbose model                        |
| ------------------ | --------------------------------------------------- | ------------------------------------ |
| `openai` (default) | `gpt-4o-transcribe`                                 | `whisper-1` + `wordTimestamps: true` |
| `gemini`           | `gemini-2.5-flash` (prompt-driven, plain text only) | —                                    |

To add a new provider, extend the `Provider` union in [`index.ts`](./index.ts) and add a `Match.when` case in `fastModelFor` (recipe side) and `layerFor` (runner side).

## Run

```sh
# Default provider: openai
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-transcription/run-node.ts path/to/audio.wav

# Gemini
GOOGLE_API_KEY=...   pnpm tsx recipes/basic-transcription/run-node.ts --provider gemini path/to/audio.wav
```

Audio formats accepted: `m4a`, `mp3`, `mp4`, `mpeg`, `mpga`, `oga`, `ogg`, `wav`, `webm`, `flac`. Both providers accept the same set; Gemini caps total request size at 20 MB inline.
