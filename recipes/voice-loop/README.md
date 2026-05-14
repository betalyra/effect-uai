---
title: Voice loop
description: "Live voice assistant: streaming STT → LLM (Gemini Flash) → streaming TTS, end-to-end, with stop-word interrupt and turn queueing. ElevenLabs Scribe v2 Realtime + `gemini-2.5-flash` + ElevenLabs Flash TTS, orchestrated as Effect fibers."
---

A full voice-loop assistant in one recipe:

```
[Browser]  getUserMedia → AudioWorklet (PCM s16le 16 kHz) → WebSocket
   ↕
[Bun server]  Effect pipeline:
   shared STT events (Stream.share)
     ├─► (1) stop-word watcher    ─► Fiber.interrupt(activeTurn) on
     │                                "stop" / "wait" / "pause" / …
     └─► (2) utterance loop:
            settleBurst("350 millis")     ─► coalesce close-together finals
            forkChild(runAssistantTurn)   ─► one fiber per turn, awaited
              LanguageModel.streamTurn({ history, model })
                .pipe(Turn.textDeltas)
              → SpeechSynthesizer.streamSynthesisFrom (ElevenLabs WS)
              → PCM s16le 48 kHz chunks sent + paced (one chunk-duration
                sleep per chunk) so the fiber stays alive while the user
                is hearing audio
[Browser]  ring-buffered AudioWorklet → speakers (cleared on cancel)
```

The recipe exercises **all three streaming abstractions** in `@effect-uai/core` simultaneously: `Transcriber` (`SttStreaming` marker), `LanguageModel`, and `SpeechSynthesizer` (`TtsIncrementalText` marker). The pipeline Effect stays provider-agnostic — switching providers is a Layer swap in `run-bun.ts`.

## Burst coalescing

Each `final` TranscriptEvent is a string. The utterance loop pipes them through `settleBurst` (recipe-local, in `streamOps.ts`) which waits for the first item then keeps collecting while subsequent items arrive within `utteranceSettle` (350 ms default) of the previous one. The window resets on each arrival — so a burst of fast-arriving finals flows together while a final followed by silence ends the burst immediately.

Why it matters for voice: ElevenLabs Scribe v2 Realtime occasionally splits a single sentence into two finals when the user has a brief mid-sentence pause ("Hello, … what's the weather?"). Without coalescing the recipe would fire two LLM round-trips and play two TTS responses for what the user perceived as one prompt. With it, the perceived utterance becomes one batched call: `"Hello what's the weather?"`.

## Stack

- **Server**: Bun + Effect (`ManagedRuntime` + `@effect-uai/elevenlabs` + `@effect-uai/google`). One pipeline fiber per WS connection; inside that, one fiber for the stop-word watcher, one for the utterance loop, and one short-lived fiber per turn for `runAssistantTurn`.
- **Client**: imperative TS in `client/main.ts`, bundled by `Bun.build` at server startup and served as `/client.js`.
- **Audio worklets**: `public/mic-worklet.js` (PCM s16le 16 kHz averaging decimator) and `public/playback-worklet.js` (ring buffer with 200 ms warmup at 48 kHz; flushed on `assistant-cancelled`).

## Run

```sh
ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... \
  bun recipes/voice-loop/run-bun.ts
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
  - **Text frames (JSON)**: `StatusEvent` — one of `user-partial` / `user-final` / `assistant-thinking` / `assistant-delta` / `assistant-done` / `assistant-cancelled` / `error`. The browser updates the chat UI from these; `assistant-cancelled` also tells the playback worklet to flush its ring buffer for instant silence.

The browser fetches `/config` at start to learn the mic + playback sample rates.

## Interruption model

Two complementary behaviors:

- **Follow-up questions queue.** A normal utterance spoken while the assistant is still answering doesn't interrupt — it sits in `settleBurst`'s buffer and runs as the next turn the moment the current one finishes. Nothing is lost. This is what `Stream.runForEach` + sequential `Fiber.await` gives you for free.
- **Stop words interrupt explicitly.** A final containing `stop` / `wait` / `pause` / `hold on` / `shut up` / `be quiet` cuts the active turn via `Fiber.interrupt`. The fiber's `Effect.onInterrupt` handler commits whatever was spoken so far to history; the browser flushes its playback ring buffer on `assistant-cancelled` so the user hears silence within ~200 ms.

We tried partial-based barge-in first (interrupt on the first "real-looking" STT partial) but it was too eager — STT speculates as you speak, and brief acknowledgments ("um", "okay") would cut the response. Finals-only + explicit stop words is unambiguous: the only way to interrupt is to deliberately say a stop word, and any other utterance is preserved as the next turn.

A final like `"Stop. Tell me about chemistry"` does both: stop watcher fires (cuts the audio), the utterance loop sees the whole string isn't a *bare* stop word, so it still runs the chemistry question as the next turn.

## Capability markers in action

The recipe relies on **both** streaming markers at once:

- `Transcriber.streamTranscriptionFrom` — gated by `SttStreaming`.
- `SpeechSynthesizer.streamSynthesisFrom` — gated by `TtsIncrementalText`.

Both are registered by `@effect-uai/elevenlabs/Eleven*` Layers, so `runPipeline` typechecks against ElevenLabs out of the box. Swap to a Layer that doesn't register either marker (e.g. `@effect-uai/openai/OpenAITranscriber` sync-only, or `@effect-uai/google/GeminiSynthesizer` sync-only) and the call becomes a **compile-time error**, not a runtime one.
