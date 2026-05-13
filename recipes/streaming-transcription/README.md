---
title: Streaming transcription
description: "Live mic → transcript over WebSocket. Switch providers with `--provider openai|elevenlabs`. Bun server bridges a browser AudioWorklet to the chosen provider's realtime endpoint."
---

Live transcription from the browser microphone, end-to-end:

```
[Browser]  getUserMedia → AudioWorklet (PCM s16le, provider-specific rate) → WebSocket
   ↕
[Bun server]  Effect pipeline:
   1. accept WS, wrap inbound mic frames as Stream<Uint8Array>
   2. Transcriber.streamTranscriptionFrom — opens the provider's realtime WS upstream
   3. push each TranscriptEvent back as JSON
[Browser]  renders partial / final transcripts live
```

The server owns the Effect Layer and the upstream provider connection; the browser is just a mic→WS adapter. To swap providers, pass `--provider <name>` — the recipe Effect in `index.ts` is generic over `Provider` and `layerFor` in `run-bun.ts` does the matching.

Sample rates differ per provider (OpenAI Realtime wants 24 kHz, ElevenLabs Scribe v2 Realtime wants 16 kHz). The client fetches `/config` on start and configures the worklet's decimator target accordingly.

## Stack

- **Server**: Bun + Effect (`ManagedRuntime`). One fiber per WS connection. Provider Layers: `@effect-uai/openai/OpenAIRealtimeTranscriber` or `@effect-uai/elevenlabs/ElevenLabsTranscriber`.
- **Client**: imperative TS (`client/main.ts`), bundled by `Bun.build` at server startup and served as `/client.js` (no Vite, no extra build step).
- **AudioWorklet**: `public/audio-worklet.js`, plain JS (worklets can't import ES modules). Converts Float32 input → Int16 little-endian and posts ~50 ms frames over `port.postMessage`.

## Run

```sh
# Default: OpenAI Realtime (24 kHz pcm16)
OPENAI_API_KEY=sk-... bun recipes/streaming-transcription/run-bun.ts

# ElevenLabs Scribe v2 Realtime (16 kHz pcm16)
ELEVENLABS_API_KEY=... bun recipes/streaming-transcription/run-bun.ts --provider elevenlabs
```

Then open <http://localhost:3000>, click **Start**, and allow microphone access. Partial transcripts appear dimmed; final segments are bold.

> **Important**: run with **`bun`**, not `pnpm tsx` — the runner uses `Bun.serve` and `Bun.build` globals that don't exist in Node.

Env vars:

- `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` — required (depending on `--provider`). For OpenAI the key authorizes the WS upgrade header directly; for ElevenLabs it fetches a single-use token first.
- `PORT` — optional, defaults to `3000`.

## Provider markers in action

`Transcriber.streamTranscriptionFrom` is gated by the `SttStreaming` capability marker on the R channel. Both `@effect-uai/openai/OpenAIRealtimeTranscriber` and `@effect-uai/elevenlabs/ElevenLabsTranscriber` register the marker, so the recipe compiles against either. Swapping to a Layer that does **not** register it — e.g. `@effect-uai/openai/OpenAITranscriber` (sync) or `@effect-uai/google/GeminiTranscriber` — turns the call into a compile-time error, not a runtime one.

## Auth: header vs query token

The two providers handle WS auth differently and both bend around the browser `WebSocket` API's inability to set headers:

- **OpenAI Realtime** requires `Authorization: Bearer …` and `OpenAI-Beta: realtime=v1` on the upgrade. The `OpenAIRealtimeTranscriber` Layer uses the `ws` peer dep (Node/Bun only) to set them. That's why this transcriber lives at a separate subpath — `OpenAITranscriber` (sync-only) doesn't pull in `ws`.
- **ElevenLabs Scribe v2 Realtime** mints a single-use token via REST (`POST /v1/single-use-token/realtime_scribe`) and carries it as a `?token=…` query param. No headers needed, so `globalThis.WebSocket` is enough.
