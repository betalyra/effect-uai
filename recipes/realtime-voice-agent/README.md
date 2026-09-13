---
title: Realtime voice agent
description: One duplex session instead of a pipeline. The model hears you, decides when you interrupted it, and calls tools mid-conversation.
source: recipes/realtime-voice-agent
icon: PiPhoneCall
---

Talk over the assistant and it stops, mid-word, because it heard you.

This recipe opens one WebSocket to a speech-to-speech model. Your voice
goes up as raw audio and its voice comes back the same way, with no
transcription step in between and no language model in the middle. The
model owns turn-taking: it decides when you finished a sentence and
when you cut it off.

**Scenario.** You want the lowest-latency voice agent you can build,
and you are willing to give up the pipeline's control over each stage
to get it. If you would rather keep that control, or want to mix
providers, [Voice loop](/recipes/voice-loop/) composes the same job out
of speech-to-text, a language model and text-to-speech.

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

Everything after that is policy, and policy is what
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/realtime-voice-agent/recipe.ts)
is. There is no agent wrapper: no hidden queue, no automatic tool
runner, no reconnect. The file is short enough to read in one sitting,
and that is the point.

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
- **Watch the latency.** Each answer carries the milliseconds it took to
  start speaking, next to the assistant line and in the server log,
  counted from the moment OpenAI decided you had stopped talking. Add
  your configured `silence_duration_ms` (500 ms by default) to get the
  wait you actually felt: the endpointing window is invisible from the
  server side. Gemini announces no end of speech, so it shows nothing
  here unless you mark the instant yourself.
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

**The model decides when it has been interrupted.** The
voice-activity detector fires on a cough or a door, so `SpeechStarted`
is informational here and does not stop the voice. `Interrupted` does:
it arrives only once the server has actually abandoned the answer, and
it arrives in order with the rest of that response. Transcripts are not
a substitute. They are unordered against the response events on Gemini
and routinely late on OpenAI, so cutting on the first recognised words
can flush an answer that has only just started.

**Only the browser knows what was heard.** The model generates several
times faster than real time, so when you interrupt, the server has
usually finished an answer the speakers are seconds behind on. The
playback worklet reports its true position when it flushes, and the
recipe sends that as `PlaybackPosition` so the unheard tail leaves the
model's memory of what it said. A server-side byte count would get this
wrong, and it stays right even for an answer the server already
considers complete.

**Echo cancellation is not optional.** The model listens while it
speaks, so without it the assistant hears itself through your speakers
and interrupts itself in a loop. The client asks for it in
`getUserMedia`.

**Tools run beside the conversation.** Each call is forked, so the
session keeps flowing while a tool works. That matters most for web
search, which is slow enough that a blocking design would leave dead
air. If the model abandons a call, which happens whenever you interrupt
it mid-call, the recipe interrupts that fiber rather than answering a
question nobody is waiting for.

## Provider Fit

Both providers run the same `recipe.ts`. What changes is the preset in
`app.ts`: the model, the voice and the sample rates, which the client
reads back from `/config`.

Gemini differs in ways you can hear:

- **No speech-started event.** Gemini reports what you said, not that
  you started making noise, so the cut fires on the first recognised
  words. That is what this recipe keys on anyway.
- **No truncate.** OpenAI can be told how much of an answer you heard
  and forgets the rest; Gemini has no such op, so on a barge-in the
  unheard tail stays in its context. The recipe still reports the
  position and the adapter logs that it dropped it.
- **The socket ends after about ten minutes**, whatever you do. A
  `SessionEnding` event arrives first, and every session asks for a
  resumption handle, which surfaces as `ResumptionHandle` events for a
  caller that wants to reconnect. Reconnecting is not this recipe's
  job, and there is no automatic reconnect in the adapter.
- **Audio out only.** The assistant transcript you see is the model's
  own output transcription, not a text modality.

Video input is not part of the common surface. Sending camera frames
requires the `RealtimeVideoInput` capability marker, which the Gemini
Layer registers and the OpenAI one does not, so `sendVideoFrame`
against OpenAI is a compile error rather than a runtime surprise.

## What This Generalizes To

The same session shape carries a phone agent, a kiosk, or a hands-free
assistant. For gating a sensitive tool behind a human while the call
stays live, see the approval pattern in
[Tool call approval](/recipes/tool-call-approval/).

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/realtime-voice-agent/recipe.ts).
