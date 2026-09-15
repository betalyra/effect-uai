---
title: Realtime
description: "One duplex session for voice: the model hears you, decides when you interrupted it, and calls tools mid-conversation."
icon: PiPhoneTransfer
---

Realtime models hold a live conversation: you stream your microphone,
and your camera where the model takes it, and the model streams its
voice back as it listens. It notices when you start talking, stops when
you interrupt it, and calls tools without leaving the call. Today that
is voice in and voice out, with video as an extra input on Gemini;
`RealtimeSession` is the service for these models, and the same session
carries whatever inputs and outputs the next ones stream.

## Start With The User Flow

- **A voice assistant**: use
  [Realtime voice agent](/recipes/realtime-voice-agent/).
- **A voice assistant that can see**: use
  [Camera assistant](/recipes/camera-assistant/). Camera frames go
  over the same session, on Gemini only.
- **A voice assistant built from separate STT, LLM and TTS models**:
  use [Voice loop](/recipes/voice-loop/). You choose each provider and
  see the text in between, at the cost of more latency.
- **Only transcription or only synthesis**: see [Speech](/speech/).

## Opening A Session

`open` connects, finishes the provider handshake, and gives you a handle
that lives as long as the scope. A configuration the provider rejects
fails here, not later as a stream that dies.

```ts
import { Effect, Stream } from "effect"
import { RealtimeInput } from "@effect-uai/core/Realtime"
import * as RealtimeSession from "@effect-uai/core/RealtimeSession"

const program = Effect.gen(function* () {
  const session = yield* RealtimeSession.open({
    model: "gpt-realtime-2.1",
    instructions: "You are a terse travel agent.",
    voiceId: "marin",
    inputFormat: pcm24k,
    outputFormat: pcm24k,
    tools: Toolkit.descriptors(toolkit),
  })

  yield* Effect.forkScoped(
    Stream.runForEach(mic, (bytes) => session.send(RealtimeInput.Audio({ bytes }))),
  )

  yield* Stream.runForEach(session.events, handleEvent)
}).pipe(Effect.scoped)
```

Provider choice is wiring, as everywhere else: `OpenAIRealtimeSession`
and `GeminiLiveSession` each register their own typed tag and the
generic `RealtimeSession`. The generic tag takes the options both
providers share; the typed tag adds that provider's own.

## Answering Events

You push `RealtimeInput` in and match `RealtimeEvent` out. Audio deltas
are what you play, `InputTranscript` is the user's own words
(`final: false` while they are still talking), and every delta sits
between a `ResponseStarted` and a `ResponseDone` with the same
`responseId`.

```ts
const handleEvent = Match.type<RealtimeEvent>().pipe(
  Match.tag("AudioDelta", (e) => playback.write(e.bytes)),
  Match.tag("OutputTranscriptDelta", (e) => show(e.text)),
  Match.tag("ToolCall", (e) => runTool(e.call)),
  Match.tag("Interrupted", () => playback.flush),
  Match.orElse(() => Effect.void),
)
```

Audio is forwarded as it arrives, without buffering, so send it at the
pace you record it.

## Running Tools Without Dead Air

Run tools in their own fiber so the conversation keeps going while
they work. A web search takes a second or two, and that is a long
silence on a call.

```ts
Match.tag("ToolCall", (e) =>
  Effect.forkScoped(
    Toolkit.run(toolkit, [e.call]).pipe(
      Stream.runForEach((event) =>
        isOutput(event)
          ? session.send(RealtimeInput.ToolResult({ output: toToolCallOutput(event.result) }))
          : Effect.void,
      ),
    ),
  ),
)
```

The model speaks the result as soon as it arrives; you do not ask for a
turn. If the user interrupts while a tool is still running, the model
drops the call and you get `ToolCallCancelled`: interrupt that fiber.

## Interruptions

When the user talks over the model, it cancels its own answer and you
get `Interrupted` before that response's `ResponseDone`. Stop playback
there.

The model has usually generated well past what the speakers have
played, and it remembers the whole answer as said. Tell it how far
playback got:

```ts
yield * session.send(RealtimeInput.PlaybackPosition({ responseId, playedMs }))
```

The unheard part then leaves the conversation. Only your client knows
`playedMs`. Gemini has no way to trim, so there it is dropped with a
warning.

## Sessions End On Their Own

`SessionEnding` warns you before the server closes the session: OpenAI
ahead of its session limit, Gemini about a minute before its ten-minute
socket ends. Gemini also emits `ResumptionHandle`, which you pass back
as `request.resume` to continue the conversation on a new session.
Reconnecting is your code's job; no adapter does it for you.

`events` ends when the socket closes cleanly. A close mid-answer fails
the stream with `IncompleteTurn`, and a close because the session ran
out fails it with `SessionExpired`, so a dropped connection never looks
like a finished answer.

## Camera Input Is Gemini Only

`sendVideoFrame` needs the `RealtimeVideoInput` marker, which only the
Gemini Layer provides. Sending frames on an OpenAI Layer is a compile
error.

## Testing

`@effect-uai/core/testing/MockRealtimeSession` scripts a session: the
events it emits on open, a function from each input to its answers, and
a record of every `send`. `layer` ships the video marker,
`layerAudioOnly` does not.

## See Also

- [Realtime voice agent](/recipes/realtime-voice-agent/) and
  [Camera assistant](/recipes/camera-assistant/): the full loop, in a
  browser.
- [OpenAI Realtime](/realtime/providers/openai/),
  [Gemini Live](/realtime/providers/gemini/).
- [Compatible endpoints](/realtime/gateways/): OpenAI-shaped gateways
  through `baseUrl`.
