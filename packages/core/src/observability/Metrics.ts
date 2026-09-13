/**
 * Measurement, layer 1. Opt-in stream operators that watch an event stream,
 * emit their own `MetricEvent` at their own cadence, and pass everything else
 * through. `Telemetry` (layer 2) records whatever they emit.
 *
 * The contract is flat here because every meter and the exporter share it. The
 * meters themselves are namespaced by the event stream they read, since that
 * is what makes a meter specific: `Metrics.Turn.*` reads `TurnEvent`,
 * `Metrics.Realtime.*` reads `RealtimeEvent`, `Metrics.Transcript.*` reads
 * `TranscriptEvent` and `Metrics.Speech.*` reads synthesized audio.
 * `Metrics.Meter.*` is the capability-free plumbing they are built from, for
 * writing your own, and `Metrics.Usage.*` is the token accounting they share.
 */
export * from "./metrics/MetricEvent.js"

export * as Meter from "./metrics/Meter.js"
export * as Realtime from "./metrics/Realtime.js"
export * as Speech from "./metrics/Speech.js"
export * as Transcript from "./metrics/Transcript.js"
export * as Turn from "./metrics/Turn.js"
export * as Usage from "./metrics/Usage.js"

export {
  /** @deprecated Use `Metrics.Turn.allMetrics`. */
  allMetrics,
  /** @deprecated Use `Metrics.Turn.throughput`. */
  throughput,
  /** @deprecated Use `Metrics.Turn.timeToCompletion`. */
  timeToCompletion,
  /** @deprecated Use `Metrics.Turn.timeToFirstToken`. */
  timeToFirstToken,
  /** @deprecated Use `Metrics.Turn.tokenTotals`. */
  tokenTotals,
} from "./metrics/Turn.js"

export type {
  /** @deprecated Use `Metrics.Turn.AllMetricsOptions`. */
  AllMetricsOptions,
  /** @deprecated Use `Metrics.Turn.OutputDelta`. */
  OutputDelta,
  /** @deprecated Use `Metrics.Turn.Throughput`. */
  Throughput,
  /** @deprecated Use `Metrics.Turn.ThroughputOptions`. */
  ThroughputOptions,
  /** @deprecated Use `Metrics.Turn.TimeToCompletion`. */
  TimeToCompletion,
  /** @deprecated Use `Metrics.Turn.TimeToFirstToken`. */
  TimeToFirstToken,
  /** @deprecated Use `Metrics.Turn.TimeToFirstTokenOptions`. */
  TimeToFirstTokenOptions,
  /** @deprecated Use `Metrics.Turn.TokenTotals`. */
  TokenTotals,
} from "./metrics/Turn.js"
