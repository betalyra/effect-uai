/**
 * Metrics for a realtime session: the presets over `RealtimeEvent`.
 *
 * A segment here is one response, delimited by `ResponseDone`. Everything is
 * measured in this process, so the microphone, the network to the browser and
 * playback itself are outside what these numbers cover.
 */
import { type Duration, Option, type Stream } from "effect"
import { RealtimeEvent } from "../../domain/Realtime.js"
import { Anchor, type MarkRef, timeToFirst } from "./Meter.js"
import { type MetricEvent, MetricEventTypeId, makeEvent } from "./MetricEvent.js"
import { usageTotals } from "./Usage.js"

const TIME_TO_FIRST_AUDIO = "effect_uai_response_time_to_first_audio"

const isAudioDelta = RealtimeEvent.$is("AudioDelta")
const isResponseDone = RealtimeEvent.$is("ResponseDone")
const isSpeechStopped = RealtimeEvent.$is("SpeechStopped")

/**
 * Which instant the clock started at, and so how the number should be read.
 *
 * - `"speech-stop"`: the session's own end-of-speech event. Excludes the
 *   endpointing window, which is configured rather than reported, so the wait
 *   a person felt is roughly this plus that silence duration.
 * - `"mark"`: an instant the caller stamped. Anchored on the acoustic end of
 *   speech this is the industry's time to first audio byte; anchored on a
 *   push-to-talk release it is the caller's intent instead.
 */
export type TimeToFirstAudioAnchor = "speech-stop" | "mark"

/** How long a response took to start speaking, once per response. */
export type TimeToFirstAudio = MetricEvent & {
  readonly _tag: "TimeToFirstAudio"
  readonly elapsed: Duration.Duration
  readonly anchor: TimeToFirstAudioAnchor
}

export type TimeToFirstAudioOptions = {
  /**
   * Where the clock starts. Defaults to `SpeechStopped`, which is sparse: a
   * session that never emits it never reports. Pass a `MarkRef` to supply the
   * instant yourself, from a push-to-talk release or a voice activity detector
   * over the audio you send; `Meter.mark` stamps it and each stamp is measured
   * from once.
   */
  readonly from?: MarkRef
}

/**
 * Elapsed from the anchor to the first `AudioDelta` of each response.
 *
 * A response whose anchor never arrived reports nothing rather than a number
 * measured from the wrong place. On the default anchor that covers a session
 * with no `SpeechStopped` at all, as well as typed input and the response
 * that resumes after a tool result.
 */
export const timeToFirstAudio = (options?: TimeToFirstAudioOptions) => {
  const from = options?.from
  const anchor: TimeToFirstAudioAnchor = from === undefined ? "speech-stop" : "mark"
  return <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A | MetricEvent, E, R> =>
    self.pipe(
      timeToFirst({
        anchor:
          from === undefined
            ? Anchor.Element({ matches: isSpeechStopped })
            : Anchor.Mark({ ref: from }),
        first: (ev) => (isAudioDelta(ev) ? Option.some(ev) : Option.none()),
        boundary: isResponseDone,
        event: ({ elapsed, segmentIndex }) =>
          makeEvent<Omit<TimeToFirstAudio, typeof MetricEventTypeId>>({
            _tag: "TimeToFirstAudio",
            turnIndex: segmentIndex,
            elapsed,
            anchor,
            // The anchor decides what the number means, so it travels with it:
            // two anchors must never average together on a dashboard.
            measurements: [
              { name: TIME_TO_FIRST_AUDIO, kind: "timer", value: elapsed, attributes: { anchor } },
            ],
          }),
      }),
    )
}

/**
 * Tokens per response and summed over the session, from the usage a response
 * reports as it ends. A response that reports none emits nothing rather than a
 * row of zeroes, and still spends its index.
 */
export const usage = usageTotals({
  boundary: isResponseDone,
  usage: (ev) =>
    isResponseDone(ev) && ev.usage !== undefined ? Option.some(ev.usage) : Option.none(),
})
