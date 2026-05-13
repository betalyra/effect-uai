---
title: Streaming synthesis
description: "Type text → audio plays as soon as the first chunk arrives. Bun server pipes incremental text into ElevenLabs `/stream-input` over WebSocket and forwards PCM chunks to the browser for back-to-back playback."
---

Incremental text-in → audio chunks back, end-to-end:

```
[Browser]  text  →  WebSocket
   ↕
[Bun server]  Effect pipeline:
   1. accept WS, split incoming text into words, push as Stream<string>
   2. SpeechSynthesizer.streamSynthesisFrom — opens ElevenLabs `/stream-input` WS upstream
   3. forward each AudioChunk's bytes back to the browser as binary
[Browser]  schedules each PCM chunk on an AudioBufferSourceNode chain — playback
   starts as soon as the first chunk arrives
```

This is the symmetric counterpart to [`streaming-transcription`](../streaming-transcription/README.md). Both use the same Bun + bundled-client pattern; only the direction of the data flow differs.

## Stack

- **Server**: Bun + Effect. One fiber per WS connection drains the text queue through `streamSynthesisFrom`.
- **Client**: imperative TS (bundled by `Bun.build` at server startup). Uses Web Audio's `AudioBufferSourceNode` chaining for gap-free streaming playback of incoming PCM chunks.
- **Audio format**: PCM s16le @ 24 kHz mono. Cheap to decode in-browser via `DataView` + `AudioBuffer.copyToChannel`, no MediaSource gymnastics.
- **Model**: `eleven_flash_v2_5` — sub-100 ms first-byte latency. Voice `JBFqnCBsd6RMkjVDRZzb` (swap inside `index.ts`).

## Run

```sh
ELEVENLABS_API_KEY=... bun recipes/streaming-synthesis/run-bun.ts
```

Open <http://localhost:3000>, paste text, click **Synthesize**. Audio should start within ~500 ms regardless of how long the text is.

> Run with **`bun`**, not `pnpm tsx` — uses `Bun.serve` and `Bun.build` globals.

## Provider markers

`SpeechSynthesizer.streamSynthesisFrom` is gated by the `TtsIncrementalText` capability marker on the R channel. `@effect-uai/elevenlabs/ElevenLabsSynthesizer` registers the marker, so the code compiles. A Layer that doesn't register it (e.g. `@effect-uai/openai/OpenAISynthesizer`, where OpenAI offers no incremental-text-in TTS) would fail at `Effect.provide` with a type error — not at runtime.
