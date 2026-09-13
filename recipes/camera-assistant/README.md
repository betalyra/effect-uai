---
title: Camera assistant
description: Point a camera at something and ask about it. Frames are one more input on the same duplex session as your voice.
source: recipes/camera-assistant
icon: PiScan
---

Ask it something, then switch the camera on and point at what you meant.

This recipe is the voice agent with a second input. The same session that
carries your voice carries JPEG stills, so "what am I looking at" is one
conversation rather than a snapshot pipeline bolted to a chat.

**Scenario.** The thing you are asking about is in front of you and
awkward to describe: a label, a part, a screen, a plant. Talking is
faster than typing, and a photo is faster than either.

## The Shape

Video is not part of the common session surface, because not every
provider has it. Sending a frame asks for a capability marker:

```ts
import * as RealtimeSession from "@effect-uai/core/RealtimeSession"

yield * RealtimeSession.sendVideoFrame(session, frame)
//       ^ requires RealtimeVideoInput in R
```

So [`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/camera-assistant/recipe.ts)
only composes against a provider that has video. Hand it an audio-only
Layer and it fails to compile, rather than failing at runtime when the
first frame goes up.

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
the context window and is billed on each following turn, so sending one
per second continuously is the expensive way to do this. The client
sends frames only while it hears you, and for a moment after. That gate
is loudness alone: it decides what the model is shown, never when it
answers.

**Resolution and compression are set by the composition.**
[`app.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/camera-assistant/app.ts)
wraps the provider's typed tag to fill in `mediaResolution: "low"` (64
tokens a frame rather than 256) and a context-compression trigger, then
registers the generic tag. `recipe.ts` never names a vendor, and the
knobs that make video affordable are still set.

**Barge-in is the provider's here.** Gemini cancels its own answer when
it hears you and says so with `Interrupted`, which stops playback. There
is no truncate op on that wire, so unlike the
[Realtime voice agent](/recipes/realtime-voice-agent/) the recipe cannot
tell the model how much you actually heard. Interrupting also drops any
tool call still running, which the transcript reports, so talking over a
slow search means asking for it again.

## What This Generalizes To

Any assistant whose subject is in front of the user rather than in the
conversation: field work, repair, shelf checks, accessibility. For the
audio-only version of the same session, and for barge-in you control,
see [Realtime voice agent](/recipes/realtime-voice-agent/).

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/camera-assistant/recipe.ts).
