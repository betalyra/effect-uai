---
title: Realtime audio
description: Voice agents — full-duplex audio, model interrupts, sub-second latency.
---

A voice agent isn't a turn — it's a duplex conversation.

Realtime audio APIs keep a long-lived connection open in both
directions. The user's audio streams in continuously; the model's
audio streams out continuously; either side can interrupt the other.
Tool calls happen mid-utterance. The turn-based primitives that work
for chat don't fit, because there's no clean boundary between "input"
and "output".

This is its own archetype: input stream plus output stream, sharing
one session, with sub-second latency budgets. It needs a primitive
neither `Effect` nor a one-direction `Stream` express on their own.

## Coming soon

When this lands, `@effect-uai/core` will gain a `RealtimeSession`
service. Likely shape: a session value carrying a `Queue<AudioIn>` you
push into and a `Stream<RealtimeEvent>` you consume from, with the
event union covering audio chunks, transcript deltas, tool calls, and
turn boundaries.

Provider candidates:

- **OpenAI Realtime** — WebSocket and WebRTC transports,
  `gpt-realtime` family.
- **Google Gemini Live** — WebSocket, multimodal in / audio out.

The right primitives — backpressure, cancellation, interrupt
semantics — get designed alongside the first integration, not in
advance.

## Show interest

Open or +1 the
[realtime audio tracking issue](https://github.com/betalyra/effect-uai/issues/new?title=Capability%3A+Realtime+audio&body=I%27m+interested+in+realtime+audio+support.+Provider%28s%29%3A+%0ATransport+%28WebSocket+%2F+WebRTC%29%3A+%0A%0AUse+case%3A+)
to tell us about the agent you'd build.
