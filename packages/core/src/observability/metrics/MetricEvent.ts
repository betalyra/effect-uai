/**
 * The contract between a meter and the exporter, and nothing else. Meters
 * (`Meter`, `Turn`, `Realtime`) mint these; `Telemetry` records them without
 * knowing which meter produced what.
 */
import { type Duration, Predicate, Result, Stream } from "effect"

// ---------------------------------------------------------------------------
// Self-describing measurements (the exporter-facing payload)
// ---------------------------------------------------------------------------

/**
 * The instrument-agnostic description of a single recorded value. The
 * `Telemetry` recorder reads only this: it builds (or reuses) a `Metric`
 * instrument from `kind` + `name` and updates it with `value`. A new metric,
 * built-in or user-defined, never requires a change to the recorder.
 */
export type Measurement = {
  readonly name: string
  readonly kind: "counter" | "histogram" | "timer" | "gauge"
  readonly value: number | Duration.Duration
  readonly attributes?: Readonly<Record<string, string>> | undefined
}

// ---------------------------------------------------------------------------
// MetricEvent: an open, brand-marked union (built-ins + user metrics)
// ---------------------------------------------------------------------------

/**
 * Brand stamped on every metric event. `isMetricEvent` checks this symbol,
 * not an enumerated `_tag`, so events are distinguished from `TurnEvent`s,
 * tool outputs, and arbitrary custom loop values regardless of their tag.
 * This is the same TypeId-symbol pattern Effect uses for `isStream` etc.
 */
export const MetricEventTypeId: unique symbol = Symbol.for(
  "@effect-uai/core/observability/MetricEvent",
)

/**
 * The structural contract every metric event satisfies, ours and custom.
 * The `_tag` + extra typed fields serve a frontend; the brand + `measurements`
 * serve the exporter.
 */
export type MetricEvent = {
  readonly [MetricEventTypeId]: typeof MetricEventTypeId
  readonly _tag: string
  /**
   * Which segment of the piped stream this sample belongs to (0-based). A
   * segment is a turn for the `Turn` meters and a response for the `Realtime`
   * ones; the field keeps the older name so existing consumers still read it.
   */
  readonly turnIndex: number
  readonly measurements: ReadonlyArray<Measurement>
}

/**
 * Mint a custom metric event. Stamp it with the brand and provide a
 * well-formed `measurements` array; `Telemetry.record` will export it with no
 * changes to the recorder. The only constraint is that each measurement's
 * `kind` is one the recorder maps.
 */
export const makeEvent = <Fields extends Omit<MetricEvent, typeof MetricEventTypeId>>(
  fields: Fields,
): Fields & { readonly [MetricEventTypeId]: typeof MetricEventTypeId } => ({
  [MetricEventTypeId]: MetricEventTypeId,
  ...fields,
})

/** Structural (brand-based) guard for any metric event, built-in or custom. */
export const isMetricEvent = (u: unknown): u is MetricEvent =>
  Predicate.hasProperty(u, MetricEventTypeId)

/**
 * Project a stream of mixed events onto just its metric samples, for a side
 * channel or a frontend feed.
 */
export const metricEvents = <A, E, R>(
  self: Stream.Stream<A, E, R>,
): Stream.Stream<MetricEvent, E, R> =>
  self.pipe(Stream.filterMap((ev) => (isMetricEvent(ev) ? Result.succeed(ev) : Result.failVoid)))
