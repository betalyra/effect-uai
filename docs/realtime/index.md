---
title: Realtime
description: "One duplex session for voice: the model hears you, decides when you interrupted it, and calls tools mid-conversation."
icon: PiPhoneTransfer
---

Realtime work starts from one user problem: "let me talk to the model
and talk over it." One socket carries your voice up and its voice back,
with no transcription step in between.

## Start With The User Flow

- **Talk to an agent, interrupt it mid-sentence**: use
  [Realtime voice agent](/recipes/realtime-voice-agent/).
- **Talk to an agent, but keep control of each stage**: use
  [Voice loop](/recipes/voice-loop/). The composed STT → LLM → TTS
  pipeline lets you mix providers and see the text between them.
- **Point a camera at something and ask about it**: a session takes
  video frames, on Gemini only.
- **Read audio into text, nothing else**: you want
  [Speech](/speech/), not a session.

Pick the pipeline unless you need model-native barge-in, tool calls
inside continuous audio, or one connection's worth of latency instead
of three. The pipeline is easier to reason about and runs anywhere.

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
generic `RealtimeSession`.

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

Both unions carry only what OpenAI Realtime and Gemini Live do
natively. VAD thresholds, truncation, thinking, grounding and noise
reduction are typed on each provider's own request.

Audio is forwarded as it arrives, unpaced and unbuffered, so send at
real time.

## Running Tools Without Dead Air

Fork the tool, or the conversation stops while it works. Web search is
where you hear this: two seconds of silence is a long time in a
conversation.

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

The adapter asks for the follow-up turn once your result is in, so you
never send a "generate now" frame yourself. When the model abandons
calls, which happens whenever you interrupt it mid-call, they arrive as
`ToolCallCancelled`: interrupt those fibers rather than answering a
question nobody is waiting for.

## "I Talked Over It And It Kept Going"

Two different things have to happen, and only one is the model's.

The model cancels its own response when it decides you interrupted, and
you get `Interrupted` before that response's `ResponseDone`. Stop
playback there.

But the model generates several times faster than real time, so it has
usually finished an answer your speakers are seconds behind on. It
believes it said all of it. Tell it what was actually heard:

```ts
yield * session.send(RealtimeInput.PlaybackPosition({ responseId, playedMs }))
```

The unheard tail then leaves the conversation. Only the client can
measure `playedMs`; a server-side byte count is wrong by exactly the
buffer it cannot see. On Gemini this is dropped with a warning, because
there is no truncate op on that wire.

## Sessions End On Their Own

`SessionEnding` warns you before the server closes: OpenAI ahead of its
session limit, Gemini about a minute before its ten-minute socket ends.
Gemini also emits `ResumptionHandle`, which you pass back as
`request.resume` to continue the conversation on a fresh session.

Reconnecting is yours, deliberately. No adapter does it behind your
back.

A close never invents a `ResponseDone`. `events` ends when the socket
closes cleanly, and a close mid-answer fails the stream with
`IncompleteTurn`, so a dropped connection can never read as a finished
answer. When the close is the session running out, the failure is
`SessionExpired` instead: a new session will work, retrying this one
will not.

## Camera Input Is Gemini Only

OpenAI Realtime has no video input, so this is a capability marker
rather than a common promise. `sendVideoFrame` requires
`RealtimeVideoInput`, which only the Gemini Layer provides, so pointing
a camera at an OpenAI-only Layer is a compile error rather than a
surprise at runtime.

## How Long It Took To Answer

`Metrics.Realtime.timeToFirstAudio` is an ordinary stream operator: stack
it on `session.events` and each response gets one sample carrying how long
it took to start speaking, with everything else passing through.

```ts
import * as Metrics from "@effect-uai/core/Metrics"

session.events.pipe(
  Metrics.Realtime.timeToFirstAudio(),
  Stream.runForEach((event) =>
    Metrics.isMetricEvent(event) ? logSample(event) : handleEvent(event),
  ),
)
```

The clock stops at the first `AudioDelta`. Where it **starts** is the only
setting, and it decides what the number means, so it rides along on the
sample and on the measurement's `attributes`: two anchors can be split or
grouped on a dashboard, never silently averaged.

By default it starts at `SpeechStopped`, the provider's own end-of-speech
event. Two things to know before you read that number:

- **Only OpenAI emits it.** Gemini Live announces nothing between you
  falling silent and the first audio chunk, so the meter reports nothing
  there rather than a zero. The same silence covers typed input and the
  response that resumes after a tool result, on either provider.
- **It excludes the endpointing window.** The provider waits out a silence
  before deciding you are done, and that wait is configured rather than
  reported (`silenceDurationMs`, 500 ms by default on OpenAI, around 800 ms
  on Gemini). The wait a person actually felt is roughly the reported
  number plus that silence.

For a start the session's own events cannot show, stamp it yourself on the
way in:

```ts
const ref = yield * Metrics.Meter.markRef

// wherever you know the turn ended: a push-to-talk release, or a voice
// activity detector over the audio you are sending
yield * Metrics.Meter.mark(ref)

session.events.pipe(Metrics.Realtime.timeToFirstAudio({ from: ref }))
```

Each mark is measured from once, so a response with no fresh mark reports
nothing rather than counting from the turn before it. Anchored on the
acoustic end of speech this is the industry's time to first audio byte;
anchored on a button release it is intent instead. No detector ships with
the library: the seam is the point, and what you put in it is yours.

## What A Response Cost

`Metrics.Realtime.usage` reports the tokens a response used and the running
total for the session, from the usage the session reports as a response ends:

```ts
session.events.pipe(Metrics.Realtime.usage)
```

Each sample carries `usage` for that response and `cumulative` for every
response so far, so the latest one is always the session total. A response
that reports no usage emits nothing rather than a row of zeroes.

The counters are the same `effect_uai_*_tokens` names the language-model
meters use, so spend adds up across capabilities on one dashboard. Stack it
with the latency meter and pipe both into
[`Telemetry.record`](/language-models/metrics/).

## Testing

`MockRealtimeSession` scripts a session: the events it emits on open, a
function from each input to its answers, and a record of every `send`.
`layer` ships the video marker, `layerAudioOnly` does not.

Writing an adapter instead? `FakeWebSocket` is an in-memory socket you
provide in place of `Socket.WebSocketConstructor`, and you play the
server with `push`, `reply` and `close`.

## See Also

- [Realtime voice agent](/recipes/realtime-voice-agent/): all of the
  above wired by hand, in a browser.
- [OpenAI Realtime](/realtime/providers/openai/),
  [Gemini Live](/realtime/providers/gemini/).
- [Compatible endpoints](/realtime/gateways/): OpenAI-shaped gateways
  through `baseUrl`.
