---
"@effect-uai/core": minor
---

New streaming metrics, with OTLP export (breaking: the old generic helpers
are replaced).

- **`@effect-uai/core/Metrics`**: small operators you stack onto a turn (or a
  whole loop) that emit typed `MetricEvent`s alongside the model's own
  events, at their own cadence. `timeToFirstToken`, `throughput` (windowed /
  cumulative, optional EWMA smoothing, char / token / event units with an
  optional tokenizer), `tokenTotals` (this turn's `usage` plus the
  `cumulative` total), and `timeToCompletion`. `allMetrics(options?)` stacks
  all four; `isMetricEvent` separates them from `TurnEvent`s downstream;
  `makeEvent` mints your own custom metric event.
- **`@effect-uai/core/Telemetry`**: `record(options?)` records the same
  events (built-in and custom) into Effect `Metric` instruments;
  `layerOtlp(options)` ships them to an OTLP endpoint, leaving the
  `HttpClient` to your runtime.
- **Removed:** the old generic stream helpers `Metrics.withElapsed`,
  `Metrics.timeToFirst`, and `Metrics.withRate`. The new turn-aware operators
  replace them.

See [Migrating to 0.9](https://effect-uai.betalyra.com/migrations/v0-9/) and
the [Metrics](https://effect-uai.betalyra.com/concepts/metrics/) concept page.
