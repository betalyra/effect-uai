---
title: Camera assistant
description: Point a camera at something and ask about it. Frames are one more input on the same duplex session as your voice.
source: recipes/camera-assistant
icon: PiScan
---

Ask it something, then switch the camera on and point at what you meant.

This recipe is the [Realtime voice agent](/recipes/realtime-voice-agent/)
with a camera. Frames go over the same session as your voice, so "what
am I looking at" is part of the conversation, not a separate photo
upload.

**Scenario.** The thing you are asking about is in front of you and
awkward to describe: a label, a part, a screen, a plant. Talking is
faster than typing, and showing is faster than either.

## The Shape

Only Gemini Live takes video, so sending a frame needs the
`RealtimeVideoInput` marker that its Layer provides:

```ts
import * as RealtimeSession from "@effect-uai/core/RealtimeSession"

yield * RealtimeSession.sendVideoFrame(session, frame)
//       ^ requires RealtimeVideoInput in R
```

Hand [`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/camera-assistant/recipe.ts)
an audio-only Layer and it does not compile.

## Run it

```sh
GOOGLE_API_KEY=... EXA_API_KEY=... bun recipes/camera-assistant/run.ts

# Share a window instead of a camera:
GOOGLE_API_KEY=... EXA_API_KEY=... bun recipes/camera-assistant/run.ts --source screen

# No camera at hand: pace a folder of JPEGs as the view.
GOOGLE_API_KEY=... EXA_API_KEY=... bun recipes/camera-assistant/run.ts --frames ./shots
```

Open <http://localhost:3000>, click **Start**, allow the microphone, and
talk. The camera is its own switch, on or off at any point; the preview
shows what the model is being sent.

Things worth trying:

- **Ask first, point later.** Turn the camera on mid-conversation. The
  session carries on.
- **Ask it to read something small**, then move closer when it says it
  cannot.
- **Switch the camera off** and ask about what it saw a minute ago; the
  frames are still in the conversation.
- **Ask it to look something up** about what it can see. Web search runs
  in its own fiber, so the conversation stays live while it works.
- **Type instead.** The text box reaches the same session.

Env vars: `GOOGLE_API_KEY`, plus a key for the search provider
(`EXA_API_KEY` by default, or `TAVILY_API_KEY` / `PERPLEXITY_API_KEY`
with `--search`). `PORT` optional (defaults to 3000).

> Run with **`bun`**, not `pnpm tsx`, if you want the bundled client:
> the runner uses `Bun.serve` and `Bun.build`.

## How The Demo Flows

```
[Browser]  mic worklet ──────────────┐
           camera → canvas → JPEG ───┤ one WebSocket (tagged frames)
   ↕                                 │
[Bun server]  RealtimeSession.open → send(Audio) / sendVideoFrame(frame)
              ToolCall → forked fiber → send(ToolResult)
   ↕
[Browser]  playback worklet (audio) + transcript (status JSON)
```

Audio is mono PCM, 16 kHz up and 24 kHz down, which the `/config` route
tells the client so the worklets resample. Frames are JPEG, longest side
768 px, at most one a second.

## Three Things Worth Knowing

**Frames cost money for the rest of the session.** Every frame stays in
the conversation and is billed again on each following turn, so
streaming one a second all the time is the expensive way to do this.
The client sends frames only while you are talking, and for a moment
after.

**Two settings keep a long session affordable.**
[`app.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/camera-assistant/app.ts)
sets `mediaResolution: "low"`, a quarter of the tokens per frame, and
`contextCompression`, so the conversation does not fill up. Both are
Gemini options, set once where the Layer is built.

**Interrupting drops a running search.** Talk over the model while it
is looking something up and it abandons the call; the transcript says
so, and you ask again. Unlike on OpenAI, the part of an answer you did
not hear stays in the conversation, since Gemini cannot trim it.

## What This Generalizes To

Any assistant whose subject is in front of the user rather than in the
conversation: field work, repair, shelf checks, accessibility. For the
audio-only version, see
[Realtime voice agent](/recipes/realtime-voice-agent/).

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/camera-assistant/recipe.ts).
