---
title: Realtime voice agent
description: One duplex session instead of a pipeline. The model hears you, decides when you interrupted it, and calls tools mid-conversation.
source: recipes/realtime-voice-agent
icon: PiPhoneCall
---

Talk over the assistant and it stops, mid-word, because it heard you.

This recipe is a voice assistant on a speech-to-speech model. Your
voice goes to the model as audio and its voice comes back as audio, and
the model handles the conversation itself: when you finished a
sentence, when you cut it off, when to call a tool.

**Scenario.** A voice assistant with the lowest latency and the most
natural turn-taking. If you would rather pick separate speech-to-text,
language and text-to-speech models and see the text in between,
[Voice loop](/recipes/voice-loop/) builds the same assistant that way.

## The Shape

A session is a handle with two halves. You push inputs in and consume
events out, for as long as the scope lives:

```ts
import * as RealtimeSession from "@effect-uai/core/RealtimeSession"
import { RealtimeInput } from "@effect-uai/core/Realtime"

const session =
  yield *
  RealtimeSession.open({
    model: "gpt-realtime-2.1",
    instructions: "You are a terse voice assistant.",
    voiceId: "marin",
    inputFormat: pcm24k,
    outputFormat: pcm24k,
    tools: Toolkit.descriptors(toolkit),
  })

yield *
  Effect.forkScoped(
    Stream.runForEach(micFrames, (bytes) => session.send(RealtimeInput.Audio({ bytes }))),
  )

yield * Stream.runForEach(session.events, handleEvent)
```

Everything else, playback, tools and interruptions, is a `Match` over
the events in
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/realtime-voice-agent/recipe.ts).
There is no agent wrapper, so the whole loop is one short file you can
read and change.

## Run it

```sh
OPENAI_API_KEY=sk-... EXA_API_KEY=... bun recipes/realtime-voice-agent/run.ts

# The same recipe on Gemini Live:
GOOGLE_API_KEY=... EXA_API_KEY=... bun recipes/realtime-voice-agent/run.ts --provider google

# Another search provider behind the same tool:
OPENAI_API_KEY=sk-... TAVILY_API_KEY=... bun recipes/realtime-voice-agent/run.ts --search tavily
```

Open <http://localhost:3000>, click **Start**, allow the microphone,
and talk. Things worth trying:

- **Interrupt it.** Ask for something long, then talk over the answer.
  It stops as soon as your first words are recognised. On OpenAI the
  part you never heard is dropped from its memory too, so it will not
  act as if it had said it.
- **Ask for the time** in some city, or the weather. The weather is
  real: Open-Meteo geocodes the place and returns current conditions,
  and it needs no key.
- **Ask something it cannot know**, like today's news. Web search takes
  a second or two, which is a long silence in a conversation, so you
  hear it say a few words, go quiet, then come back with the answer.
  The call and its arguments appear in the transcript.
- **Type instead.** The text box reaches the same session, so you can
  mix typing and talking in one conversation.
- **Ask how it works.** The assistant is called Betty, and the
  instructions cover what effect-uai is and how this recipe streams
  audio end to end, so Betty can explain the thing it is running on.

Env vars: `OPENAI_API_KEY` (or `GOOGLE_API_KEY` with `--provider
google`), plus a key for the search provider
(`EXA_API_KEY` by default, or `TAVILY_API_KEY` / `PERPLEXITY_API_KEY`
with `--search`). `PORT` optional (defaults to 3000).

> Run with **`bun`**, not `pnpm tsx`, if you want the bundled client:
> the runner uses `Bun.serve` and `Bun.build`.

## How The Demo Flows

```
[Browser]  getUserMedia → mic worklet → WebSocket (binary PCM)
   ↕
[Bun server]  RealtimeSession.open → send(Audio) / events
              ToolCall → forked fiber → send(ToolResult)
              Interrupted → "interrupted" → send(PlaybackPosition)
   ↕
[Browser]  playback worklet (audio) + transcript (status JSON)
```

The server owns the session; the browser is a microphone, a speaker
and a transcript. Audio is mono PCM at whatever rates the provider
fixes (OpenAI 24 kHz both ways, Gemini 16 kHz up and 24 kHz down),
which the `/config` route tells the client so the worklets resample to
match.

## Four Things Worth Knowing

**The model decides when it has been interrupted.** `SpeechStarted`
only means the microphone picked something up, and a cough sets it off,
so the recipe shows it but keeps playing. `Interrupted` means the model
has dropped its answer, and that is what stops the voice.

**Only the browser knows what was heard.** The model finishes
generating long before the speakers catch up, so when you interrupt it,
it remembers a whole answer you heard half of. The playback worklet
reports how far it got, and the recipe sends that as `PlaybackPosition`
so the unheard part leaves the conversation.

**Echo cancellation is not optional.** The model listens while it
speaks, so without it the assistant hears itself through your speakers
and interrupts itself in a loop. The client asks for it in
`getUserMedia`.

**Tools run beside the conversation.** Each call runs in its own fiber,
so the assistant keeps talking while a web search works. If you
interrupt it mid-call, the model drops the call and the recipe stops
the fiber.

## Provider Fit

Both providers run the same `recipe.ts`. `app.ts` picks the model, the
voice and the sample rates, and the client reads those from `/config`.

What you will notice on Gemini:

- **No `SpeechStarted`.** The transcript still shows the interruption;
  the "speech started" marker just never appears.
- **Nothing is trimmed after an interruption.** Gemini cannot be told
  how much you heard, so the unheard part of an answer stays in the
  conversation.
- **Sessions end after about ten minutes.** `SessionEnding` arrives
  first and `ResumptionHandle` events let a caller reconnect. This
  recipe does not; the page shows the session as ended.
- **Camera input.** Only Gemini takes video. [Camera assistant](/recipes/camera-assistant/)
  is this recipe with the camera added.

## What This Generalizes To

The same session shape carries a phone agent, a kiosk, or a hands-free
assistant. For gating a sensitive tool behind a human while the call
stays live, see the approval pattern in
[Tool call approval](/recipes/tool-call-approval/).

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/realtime-voice-agent/recipe.ts).
