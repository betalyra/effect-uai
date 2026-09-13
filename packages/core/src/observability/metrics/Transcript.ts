/**
 * Metrics for streaming speech to text: the presets over `TranscriptEvent`.
 *
 * A segment here is one utterance, delimited by the `final` that commits it.
 */
import { type Duration, Option, type Stream } from "effect"
import { isFinal, isUtteranceEnded } from "../../domain/Transcript.js"
import { Anchor, timeToFirst } from "./Meter.js"
import { type MetricEvent, MetricEventTypeId, makeEvent } from "./MetricEvent.js"

const FINAL_LATENCY = "effect_uai_transcript_final_latency"

/** How long after the speaker stopped the committed transcript arrived. */
export type FinalLatency = MetricEvent & {
  readonly _tag: "FinalLatency"
  readonly elapsed: Duration.Duration
}

/**
 * Elapsed from `utterance-ended` to the `final` that commits it, once per
 * utterance. This is the pause before a pipeline can act on what was said, so
 * it is what decides how a voice loop feels.
 *
 * Wall clock in this process, so the network from the audio source counts and
 * the speaker's own microphone does not. An utterance whose `utterance-ended`
 * never arrived reports nothing: the event is sparse, and a transcriber that
 * never emits it never reports here.
 */
export const finalLatency = <A, E, R>(
  self: Stream.Stream<A, E, R>,
): Stream.Stream<A | MetricEvent, E, R> =>
  self.pipe(
    timeToFirst({
      anchor: Anchor.Element({ matches: isUtteranceEnded }),
      first: (ev) => (isFinal(ev) ? Option.some(ev) : Option.none()),
      boundary: isFinal,
      event: ({ elapsed, segmentIndex }) =>
        makeEvent<Omit<FinalLatency, typeof MetricEventTypeId>>({
          _tag: "FinalLatency",
          turnIndex: segmentIndex,
          elapsed,
          measurements: [{ name: FINAL_LATENCY, kind: "timer", value: elapsed }],
        }),
    }),
  )
