---
title: Realtime
description: Duplex sessions — model-native barge-in, server-side VAD, voice + camera in / voice + text out.
---

For voice assistants you can ship today, see
[Speech → Voice loop](/recipes/voice-loop/). The composed STT → LLM →
TTS pipeline covers the common case and runs on the shipped speech
primitives.

This page is about the **other** archetype: one long-lived duplex
session where the model owns turn-taking, can interrupt itself on
detected user speech, and can take camera frames alongside audio. That
primitive isn't shipped yet.

## What Realtime adds

A pipeline of `Transcriber → LanguageModel → SpeechSynthesizer` gives
you most of a voice agent — but it has four properties a native
duplex API will improve on:

- **Model-native barge-in.** Voice loop's interrupt fires on
  stop-words detected client-side from finals. A native session lets
  the model decide it's been interrupted (server-side VAD on the input
  audio) and trim its own response — no keyword list, no client
  detection.
- **Mid-utterance tool calls.** In the pipeline, a turn is atomic:
  STT → LLM → TTS, then the next turn. A native session can interleave
  tool calls into the same continuous audio stream.
- **Sub-200 ms turn-taking.** The pipeline pays for every boundary
  (STT-final, LLM TTFT, TTS first-byte). A native session amortizes
  some of that overhead by keeping a single WebSocket open.
- **Camera-in streams.** When a provider ships realtime _vision_,
  pointing a phone camera at something and getting a spoken answer
  becomes one session — not a pipeline of "snapshot every N seconds →
  multimodal LM → TTS."

If you don't need any of those, the voice-loop pipeline is the
simpler answer and exercises the same primitives you already use.

## Coming soon

When this lands, `@effect-uai/core` will ship a `RealtimeSession`
service. Likely shape: a session value carrying a `Queue<RealtimeInput>`
you push into (audio frames, video frames, text, control) and a
`Stream<RealtimeEvent>` you consume from (audio chunks, transcript
deltas, tool calls, turn boundaries).

Provider candidates:

- **OpenAI Realtime** — WebSocket and WebRTC transports, `gpt-realtime`
  family. Audio in / audio out today; vision input on the roadmap.
- **Google Gemini Live** — WebSocket, audio + video in / audio + text
  out. The closest thing to "point your camera, get an answer" today.

The right primitives — backpressure, cancellation, interrupt
semantics — get designed alongside the first integration, not in
advance.

## See also

- [Voice loop](/recipes/voice-loop/) — the ship-today voice agent.
- [Speech](/speech/) — the one-direction primitives the voice loop
  is built from.
