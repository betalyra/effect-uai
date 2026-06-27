---
title: Voice loop
description: Talk to your agent. Streaming STT to LLM to streaming TTS, with stop-word interrupt and follow-up queueing.
source: recipes/voice-loop
icon: PiMicrophone
---

A voice assistant is three streams talking to each other.

Speech-to-text turns the user's mic into committed utterances. The LLM
answers each utterance. Streaming text-to-speech reads the answer aloud
as soon as the first deltas arrive.

**Scenario.** Open a tab, click **Start**, allow mic access, ask a
question. Ask a follow-up while the assistant is still speaking and it
queues. Say "stop" mid-answer and playback is cancelled so you can ask
the next thing.

## The Pipeline

The recipe composes three provider surfaces without a voice-assistant
framework:

- `Transcriber.streamTranscriptionFrom` listens to the mic and emits
  partial and final transcript events.
- `LanguageModel.streamTurn` answers each final utterance.
- `SpeechSynthesizer.streamSynthesisFrom` turns the LLM's text deltas
  into audio chunks.

The pipeline is still ordinary Effect code. Provider selection and the
HTTP/WebSocket server live in `app.ts`; the recipe body in `index.ts`
works against the service tags and capability markers, so swapping the
whole STT/LLM/TTS stack is a Layer change, not a code change.

Two stacks ship: the default `elevenlabs` stack (ElevenLabs STT/TTS +
Gemini LLM) and an all-Mistral `mistral` stack (Voxtral Realtime STT,
a Mistral chat model, Voxtral TTS). Pick one with `--provider`.

## Turn Handling

Each committed user utterance becomes one assistant turn. The outer
stream runs turns sequentially, so a follow-up spoken while the
assistant is answering waits its turn instead of racing the current
answer.

Realtime STT can split one human sentence into multiple finals around a
short pause. The local `settleBurst` helper waits briefly before
starting the LLM, so "what about Paris ... in winter?" is treated as
one user turn.

## Interruption model

The assistant has two behaviors:

- **Follow-up questions queue.** A normal utterance spoken while the
  assistant is still answering runs after the current turn completes.
  Nothing is lost.
- **Stop words interrupt explicitly.** A final containing a stop
  word cuts the active turn via `Fiber.interrupt`. The interrupt
  handler commits whatever was spoken so far, and the browser flushes
  playback on `assistant-cancelled`.

The recipe intentionally interrupts on final transcripts, not partials.
Partials are speculative; a half-heard "okay" should not cancel the
assistant. A final like `"Stop. Tell me about chemistry"` both cancels
the current audio and queues the chemistry question as the next turn.

## Run it

The recipe runs on Bun, Node, or Deno. The runtime-specific file only
attaches platform layers (`HttpServer`, `FileSystem`, `Path`,
`HttpClient`); `app.ts` and `index.ts` are shared.

```sh
# Default stack: ElevenLabs STT/TTS + Gemini LLM
ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... bun recipes/voice-loop/run-bun.ts
ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... pnpm tsx recipes/voice-loop/run-node.ts
ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... deno run --allow-all recipes/voice-loop/run-deno.ts

# All-Mistral stack (Voxtral STT/TTS + Mistral LLM)
MISTRAL_API_KEY=... bun recipes/voice-loop/run-bun.ts --provider=mistral
```

Open <http://localhost:3000>, click **Start**, allow mic access,
speak.

Env vars:

- `ELEVENLABS_API_KEY` — `elevenlabs` stack: STT (Scribe v2 Realtime)
  and TTS (Flash v2.5).
- `GOOGLE_API_KEY` — `elevenlabs` stack: Gemini 2.5 Flash.
- `MISTRAL_API_KEY` — `mistral` stack: Voxtral STT/TTS + Mistral LLM.
- `PORT` — optional, defaults to `3000`.
- `PIPELINE_DEBUG=1` — optional, logs every partial transcript.

## Architecture

```
[Browser]  getUserMedia → AudioWorklet → WebSocket
   ↕
[server]  Effect pipeline (one per WS connection), via HttpRouter +
   HttpServerRequest.upgradeChannel — same code on Bun / Node / Deno:
   shared STT events (Stream.share)
     ├─► stop-word watcher    ─► Fiber.interrupt(activeTurn) on "stop" / …
     └─► utterance loop:
            settleBurst("350 millis")     ─► coalesce close-together finals
            forkChild(runAssistantTurn)   ─► one fiber per turn, awaited
              LanguageModel.streamTurn(...) → Turn.textDeltas
              → SpeechSynthesizer.streamSynthesisFrom (provider WS)
              → raw PCM chunks sent + paced
[Browser]  ring-buffered AudioWorklet → speakers (cleared on cancel)
```

One WebSocket carries the demo traffic:

- **Browser → server**: binary frames only. Each is ~50 ms of PCM
  s16le @ 16 kHz mono mic audio from `mic-worklet.js`.
- **Server → browser**:
  - **Binary frames** — PCM s16le mono TTS audio (sample rate per
    `/config`: 48 kHz for the `elevenlabs` stack, 24 kHz for `mistral`).
  - **Text frames (JSON)** — `StatusEvent`: `user-partial` /
    `user-final` / `assistant-thinking` / `assistant-delta` /
    `assistant-done` / `assistant-cancelled` / `error`. The browser
    updates the chat UI from these; `assistant-cancelled` also tells
    the playback worklet to flush its ring buffer for instant
    silence.

The browser fetches `/config` at start to learn the mic + playback
sample rates.

## What This Generalizes To

The recipe is a worked example of three primitives composed with
ordinary Effect concurrency. The same shape applies whenever you
have:

- A long-lived input stream that occasionally emits a _commit_
  (transcription finals; chat messages; sensor thresholds);
- Work per commit that should run one-at-a-time;
- An interrupt signal that needs to cut the active work cleanly.

Swap STT for a Kafka topic, the LLM for any per-message Effect, and
TTS for a downstream service — the fiber-per-turn + `Stream.share` +
stop-word watcher structure carries over without changes.

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/voice-loop/recipe.ts)
(pipeline logic) and
[`app.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/voice-loop/app.ts)
(provider selection + server).
