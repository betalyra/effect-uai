---
title: Audio assistant pipeline
description: "Live voice assistant: streaming STT → queued LLM (Gemini Flash) → streaming TTS, end-to-end. ElevenLabs Scribe v2 Realtime + `gemini-2.5-flash` + ElevenLabs Flash TTS, wired together as one Effect."
---

A full voice-loop assistant in one recipe:

```
[Browser]  getUserMedia → AudioWorklet (PCM s16le 16 kHz) → WebSocket
   ↕
[Bun server]  Effect pipeline:
   1. Transcriber.streamTranscriptionFrom  ─► partial / final TranscriptEvents
        partial → JSON status to browser (live caption)
        final   → enqueue into utteranceQueue
   2. consumer fiber:
        drainBurst(utteranceQueue, "350 millis")     ─► coalesce close-
                                                       together finals
        LanguageModel.streamTurn({ history, model: "gemini-2.5-flash" })
          .pipe(Turn.textDeltas)
        → fed into SpeechSynthesizer.streamSynthesisFrom (ElevenLabs WS)
        → PCM s16le 48 kHz chunks streamed back as binary WS frames
[Browser]  ring-buffered AudioWorklet → speakers
```

The recipe exercises **all three streaming abstractions** in `@effect-uai/core` simultaneously: `Transcriber` (`SttStreaming` marker), `LanguageModel`, and `SpeechSynthesizer` (`TtsIncrementalText` marker). The pipeline Effect stays provider-agnostic — switching providers is a Layer swap in `run-bun.ts`.

## Burst coalescing

Each `final` TranscriptEvent enqueues a string. The consumer fiber uses `drainBurst` (same pattern as [`recipes/agentic-loop`](../agentic-loop/)) to wait for the first item, then keep collecting while subsequent items arrive within `utteranceSettle` (350 ms default) of the previous one. The window resets on each arrival — so a burst of fast-arriving finals flows together while a final followed by silence ends the burst immediately.

Why it matters for voice: ElevenLabs Scribe v2 Realtime occasionally splits a single sentence into two finals when the user has a brief mid-sentence pause ("Hello, … what's the weather?"). Without coalescing the recipe would fire two LLM round-trips and play two TTS responses for what the user perceived as one prompt. With it, the perceived utterance becomes one batched call: `"Hello what's the weather?"`.

## Stack

- **Server**: Bun + Effect (`ManagedRuntime` + `@effect-uai/elevenlabs` + `@effect-uai/google`). One fiber per WS connection; inside that, one fiber for the STT producer and one for the LLM-+-TTS consumer.
- **Client**: imperative TS in `client/main.ts`, bundled by `Bun.build` at server startup and served as `/client.js`.
- **Audio worklets**: `public/mic-worklet.js` (PCM s16le 16 kHz averaging decimator) and `public/playback-worklet.js` (ring buffer with 200 ms warmup at 48 kHz).

## Run

```sh
ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... \
  bun recipes/audio-assistant-pipeline/run-bun.ts
```

Open <http://localhost:3000>, click **Start**, allow microphone access, and speak.

> **Important**: run with **`bun`** — the runner uses `Bun.serve` and `Bun.build`.

Env vars:

- `ELEVENLABS_API_KEY` — used for both STT (Scribe v2 Realtime) and TTS (Flash v2.5).
- `GOOGLE_API_KEY` — used for Gemini 2.5 Flash.
- `PORT` — optional, defaults to `3000`.

## Wire format

Single bi-directional WebSocket at `/ws`. Discriminated by frame type:

- **Browser → server**: binary frames only. Each frame is ~50 ms of PCM s16le @ 16 kHz mono mic audio, produced by `mic-worklet.js`.
- **Server → browser**:
  - **Binary frames**: PCM s16le @ 48 kHz mono TTS audio, played through the ring-buffered worklet.
  - **Text frames (JSON)**: `StatusEvent` — one of `user-partial` / `user-final` / `assistant-thinking` / `assistant-delta` / `assistant-done` / `error`. The browser updates the chat UI from these.

The browser fetches `/config` at start to learn the mic + playback sample rates.

## Barge-in (intentional non-feature)

If the user speaks while the assistant is still talking, the new utterance **queues** — it's processed after the current TTS playback finishes. Real voice assistants typically interrupt: the next user partial cancels the in-flight LLM stream and clears the TTS WS.

The pipeline structure makes barge-in trivial to add (cancel the consumer fiber on the first `partial` while the assistant is speaking) but it has UX tradeoffs — accidental sounds (coughs, background voices) shouldn't cancel a response. We picked queue semantics so the recipe stays predictable; the README intentionally surfaces the gap.

## Capability markers in action

The recipe relies on **both** streaming markers at once:

- `Transcriber.streamTranscriptionFrom` — gated by `SttStreaming`.
- `SpeechSynthesizer.streamSynthesisFrom` — gated by `TtsIncrementalText`.

Both are registered by `@effect-uai/elevenlabs/Eleven*` Layers, so `runPipeline` typechecks against ElevenLabs out of the box. Swap to a Layer that doesn't register either marker (e.g. `@effect-uai/openai/OpenAITranscriber` sync-only, or `@effect-uai/google/GeminiSynthesizer` sync-only) and the call becomes a **compile-time error**, not a runtime one.
