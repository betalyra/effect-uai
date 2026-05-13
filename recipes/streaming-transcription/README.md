---
title: Streaming transcription
description: "Live mic → transcript via ElevenLabs `scribe_v2_realtime` over WebSocket. Bun server bridges a browser AudioWorklet to the provider's realtime endpoint."
---

Live transcription from the browser microphone, end-to-end:

```
[Browser]  getUserMedia → AudioWorklet (PCM s16le 16 kHz) → WebSocket
   ↕
[Bun server]  Effect pipeline:
   1. accept WS, wrap inbound mic frames as Stream<Uint8Array>
   2. Transcriber.streamTranscriptionFrom — opens ElevenLabs realtime WS upstream
   3. push each TranscriptEvent back as JSON
[Browser]  renders partial / final transcripts live
```

The server owns the Effect Layer and the upstream provider connection; the browser is just a mic→WS adapter. To swap providers later (Cloud Speech Chirp 2, OpenAI Realtime, …) you only change `layerFor` in `run-bun.ts` — the recipe Effect in `index.ts` stays provider-agnostic.

## Stack

- **Server**: Bun + Effect (`ManagedRuntime` + `@effect-uai/elevenlabs`). One fiber per WS connection.
- **Client**: Effect on the frontend too — `client/main.ts` is bundled by `Bun.build` at server startup and served as `/client.js` (no Vite, no extra build step). Scope-based resource management for mic / AudioContext / WebSocket.
- **AudioWorklet**: `public/audio-worklet.js`, plain JS (worklets can't import ES modules). Converts Float32 input → Int16 little-endian and posts ~50 ms frames over `port.postMessage`.

## Run

```sh
ELEVENLABS_API_KEY=... bun recipes/streaming-transcription/run-bun.ts
```

Then open <http://localhost:3000>, click **Start**, and allow microphone access. Partial transcripts appear dimmed; final segments are bold.

> **Important**: run with **`bun`**, not `pnpm tsx` — the runner uses `Bun.serve` and `Bun.build` globals that don't exist in Node.

Env vars:

- `ELEVENLABS_API_KEY` — required. Used by the server to fetch a single-use token for the realtime WS endpoint.
- `PORT` — optional, defaults to `3000`.

## Provider markers in action

`Transcriber.streamTranscriptionFrom` is gated by the `SttStreaming` capability marker on the R channel. The `@effect-uai/elevenlabs/ElevenLabsTranscriber` Layer registers the marker, so calls compile. If you swap to a Layer that doesn't register it — e.g. `@effect-uai/openai-speech/OpenAITranscriber` (sync-only) — the same code would fail at `Effect.provide` with a type error, not at runtime.
