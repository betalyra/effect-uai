import { Duration, Effect, Layer, Match, Metric, Stream } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { OtlpMetrics, OtlpSerialization } from "effect/unstable/observability"
import { isMetricEvent, type Measurement, type MetricEvent } from "./Metrics.js"

// ---------------------------------------------------------------------------
// The agnostic recorder
// ---------------------------------------------------------------------------

/**
 * Histogram bucket boundaries used for every histogram measurement (the only
 * built-in one is throughput). Custom histogram metrics share these; a metric
 * that needs bespoke boundaries can update its own instrument directly instead
 * of routing through `record`.
 */
const histogramBoundaries = Metric.exponentialBoundaries({ start: 1, factor: 2, count: 16 })

/**
 * Build the effect `Metric` instrument a measurement maps to. Dispatches on
 * `kind`, never on the event `_tag`, so a new built-in or custom metric needs
 * no change here. Instruments dedupe by name in the global registry, so a fresh
 * instance per call accumulates onto the same series (no cache needed).
 */
const buildInstrument = (m: Measurement): Metric.Metric<any, any> =>
  Match.value(m.kind).pipe(
    Match.when("counter", () => Metric.counter(m.name, { incremental: true })),
    Match.when("histogram", () => Metric.histogram(m.name, { boundaries: histogramBoundaries })),
    Match.when("timer", () => Metric.timer(m.name)),
    Match.when("gauge", () => Metric.gauge(m.name)),
    Match.exhaustive,
  )

const mergeAttributes = (
  base: Readonly<Record<string, string>> | undefined,
  extra: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined =>
  base === undefined ? extra : extra === undefined ? base : { ...base, ...extra }

const recordEvent = (
  ev: MetricEvent,
  baseAttributes: Readonly<Record<string, string>> | undefined,
): Effect.Effect<void> =>
  Effect.forEach(
    ev.measurements,
    (m) => {
      const attributes = mergeAttributes(baseAttributes, m.attributes)
      const base = buildInstrument(m)
      const instrument = attributes === undefined ? base : Metric.withAttributes(base, attributes)
      return Metric.update(instrument, m.value)
    },
    { discard: true },
  )

export type RecordOptions = {
  /** Attributes applied to every recorded metric, e.g. `{ model, provider }`. */
  readonly attributes?: Readonly<Record<string, string>>
}

/**
 * Record every measurement on every metric event into effect `Metric`
 * instruments, then pass events through unchanged. Matches events structurally
 * (`isMetricEvent`), so it records built-in and custom metrics alike, and
 * dispatches on `measurement.kind`, never on the event tag. Sits mid-pipeline
 * before the transport. Provide an OTLP (or Prometheus) layer to export the
 * instruments it populates.
 */
export const record =
  (options?: RecordOptions) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    self.pipe(
      Stream.tap((ev) => (isMetricEvent(ev) ? recordEvent(ev, options?.attributes) : Effect.void)),
    )

// ---------------------------------------------------------------------------
// OTLP wiring
// ---------------------------------------------------------------------------

export type LayerOtlpOptions = {
  readonly url: string
  readonly resource?: {
    readonly serviceName?: string
    readonly serviceVersion?: string
  }
  readonly exportInterval?: Duration.Input
}

/**
 * Convenience layer that exports recorded metrics over OTLP. Provides the JSON
 * serializer and leaves `HttpClient` as a requirement, so the platform's client
 * (FetchHttpClient, NodeHttpClient, ...) is provided at the edge. This keeps
 * the library platform-independent.
 */
export const layerOtlp = (
  options: LayerOtlpOptions,
): Layer.Layer<never, never, HttpClient.HttpClient> =>
  OtlpMetrics.layer(options).pipe(Layer.provide(OtlpSerialization.layerJson))
