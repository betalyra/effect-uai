/**
 * Metrics for speech synthesis: the presets over a stream of `AudioChunk`.
 *
 * A synthesis is one segment, so these report once per stream rather than
 * once per turn.
 */
import { type Duration, Option, type Stream } from "effect"
import { Anchor, timeToFirst } from "./Meter.js"
import { type MetricEvent, MetricEventTypeId, isMetricEvent, makeEvent } from "./MetricEvent.js"

const TIME_TO_FIRST_BYTE = "effect_uai_speech_ttfb"

/** How long before the voice started, once per synthesis. */
export type TimeToFirstByte = MetricEvent & {
  readonly _tag: "TimeToFirstByte"
  readonly elapsed: Duration.Duration
}

/**
 * Elapsed from the request to the first `AudioChunk`. The clock starts when
 * the stream initializes, which is when the provider request fires, so
 * connection and prefill are both in the number. It is the only synthesis
 * latency a listener notices.
 *
 * One sample per stream, so an incremental synthesis fed by a long-lived text
 * stream reports when its voice started, not once per utterance.
 */
export const timeToFirstByte = <A, E, R>(
  self: Stream.Stream<A, E, R>,
): Stream.Stream<A | MetricEvent, E, R> =>
  self.pipe(
    timeToFirst({
      anchor: Anchor.Request(),
      // A synthesis stream carries audio, so the first element that is not
      // another meter's sample is the first audio.
      first: (ev) => (isMetricEvent(ev) ? Option.none() : Option.some(ev)),
      boundary: () => false,
      event: ({ elapsed, segmentIndex }) =>
        makeEvent<Omit<TimeToFirstByte, typeof MetricEventTypeId>>({
          _tag: "TimeToFirstByte",
          turnIndex: segmentIndex,
          elapsed,
          measurements: [{ name: TIME_TO_FIRST_BYTE, kind: "timer", value: elapsed }],
        }),
    }),
  )
