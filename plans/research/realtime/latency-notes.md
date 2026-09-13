# Realtime latency, measured (2026-09-13)

Live check for [metrics.md](../../metrics.md) section 8.4, task 1d. Run
through `recipes/realtime-voice-agent` with
`Metrics.Realtime.timeToFirstAudio` stacked on `session.events` in
`app.ts`, both anchors at once, spoken input over a laptop microphone
from Portugal against each provider's default region.

|                | value                                                                      |
| -------------- | -------------------------------------------------------------------------- |
| OpenAI model   | `gpt-realtime-2.1`, voice `marin`, PCM 24 kHz both ways                    |
| Gemini model   | `gemini-3.1-flash-live-preview`, voice `Kore`, PCM 16 kHz up / 24 kHz down |
| Turn detection | server VAD, provider defaults, no knobs set by the recipe                  |
| Client         | Chrome, `echoCancellation` + `noiseSuppression` + `autoGainControl` on     |

## What the two anchors turned out to measure

The headline is not a number. Both anchors are unusable as a
cross-provider latency, for different reasons, and the reasons are
structural rather than noise.

**OpenAI: the two anchors are the same anchor.** `response.created`
arrives about 2 ms after `input_audio_buffer.speech_stopped`, because
the server opens the response as soon as it commits the input buffer.
One traced turn, wall clock from the adapter's own event stream:

```
SpeechStarted     t=217888
SpeechStopped     t=218174     286 ms of speech
ResponseStarted   t=218176     2 ms after speech stopped
AudioDelta        t=218954     778 ms after that
```

So `turn-latency` (780 ms) and `ttfa` (778 ms) differ by the 2 ms
between the two frames. A second turn measured 812 / 810 ms, the same
2 ms apart.

The endpointing cost that `"speech-stop"` was added to expose is not
between these two anchors. It sits _before_ both: the VAD's silence
window is part of deciding when `speech_stopped` fires at all, so from
inside this process the moment the user stopped making sound is not
observable. Both numbers therefore understate the wait a person
perceives by roughly the configured silence duration.

**Gemini: `ResponseStarted` is the first audio.** Gemini Live has no
"response created" frame, so the adapter mints `ResponseStarted` on the
first event of a turn
([`startTurn`](../../../packages/providers/google/src/realtimeSession.ts)).
For an audio-out session that first event is the first `AudioDelta`,
carried in the same `serverContent` batch, so the anchor and the
measurement land together:

```
[metrics] ttfa 0ms (response 0)
```

`0 ms` is what this meter will always report there. `"speech-stop"`
reports nothing at all on Gemini, as designed, since it emits no
`SpeechStopped`.

|        | `from: "response"`     | `from: "speech-stop"`               |
| ------ | ---------------------- | ----------------------------------- |
| OpenAI | real, 778 and 810 ms   | real, always ~2 ms above `response` |
| Gemini | always ~0, meaningless | never fires                         |

## What was shipped instead

One metric whose only setting is where the clock starts, since the end
(first `AudioDelta`) was always the same and only the start differed.
The anchor rides on the sample and on the measurement's `attributes`, so
two meanings never average together.

The default is the provider's `SpeechStopped`, which reports on OpenAI
and stays silent on Gemini rather than reporting a zero. For a start the
session's own events cannot show, `Meter.mark(ref)` stamps it on the way
in and `timeToFirstAudio({ from: ref })` measures from there: a
push-to-talk release, or a voice activity detector over the audio being
sent. We ship the seam and no detector. See
[metrics.md](../../metrics.md) 8.5 and 8.6.

The p50 and p95 that 1d asked for are not recorded. Ten turns would pin
OpenAI's number to a useful precision, but it would be one provider with
no comparable partner and Gemini would contribute ten silences. Worth
redoing once an anchor exists that both providers can answer.
