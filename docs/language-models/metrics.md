---
title: Metrics
description: Measure a streaming generation as it runs - time to first token, throughput, token counts, completion time - and log it live or ship it to OTLP.
---

While a generation streams, you usually want to know how it's going: how long
until the first token, how fast tokens are coming, how many you spent, how
long the whole thing took. Each of those is a small operator you stack onto
the stream. They emit typed `MetricEvent`s alongside the model's own events,
at their own cadence, and leave everything else untouched.

## Attach the meters

`Metrics.Turn.allMetrics` stacks all four built-ins onto a turn:

```ts
import * as Metrics from "@effect-uai/core/Metrics"

const metered = LanguageModel.streamTurn(request).pipe(Metrics.Turn.allMetrics())
```

Now your stream carries two kinds of element: the model's `TurnEvent`s (the
text deltas) and the `MetricEvent`s. Tell them apart with `isMetricEvent` and
do what you like with each - here, log the metrics and keep the text:

```ts
metered.pipe(
  Stream.runForEach((event) => (Metrics.isMetricEvent(event) ? Console.log(event) : Effect.void)),
)
```

The four samples and the fields you read off them:

| Operator           | Fires                  | Read                              |
| ------------------ | ---------------------- | --------------------------------- |
| `timeToFirstToken` | on the first token     | `elapsed`, `kind`                 |
| `throughput`       | every interval         | `ratePerSecond`, `unit`, `window` |
| `tokenTotals`      | when the turn finishes | `usage`, `cumulative`             |
| `timeToCompletion` | when the turn finishes | `duration`, `generation`          |

Meters are namespaced by the events they read, because that is what makes a
meter specific: `Metrics.Turn.*` reads `TurnEvent`, and
[`Metrics.Realtime.*`](/realtime/) reads a speech-to-speech session's events.
The event and export machinery is shared and flat, so `isMetricEvent`,
`makeEvent` and `Telemetry.record` handle anything you emit.

## Measure only what you need

The meters are independent operators; pipe just the ones you want instead of
`allMetrics`:

```ts
LanguageModel.streamTurn(request).pipe(Metrics.Turn.timeToFirstToken(), Metrics.Turn.tokenTotals)
```

`throughput` reports a live rate. It counts characters by default (exact on
every provider); for tokens, hand it a tokenizer, or estimate:

```ts
Metrics.Turn.throughput({
  every: "1 second",
  unit: "token",
  tokenizer: (event) =>
    Effect.succeed(
      (event._tag === "ToolCallArgsDelta" ? event.delta.length : event.text.length) / 4,
    ),
})
```

Every delta that carries generated output is measured: prose, reasoning,
refusals, and tool-call arguments. That last one matters for agents, whose
output is often mostly tool calls rather than text. The tokenizer is only
called for those deltas, so it never has to filter out turn bookkeeping.

It's `windowed` by default (the current rate); pass `mode: "cumulative"` for a
running average, or `smooth: "default"` to damp the jitter.

## One generation or a whole loop

Scope follows where you attach. The same meter gives you per-generation
numbers on a single turn and whole-run numbers on a loop:

```ts
LanguageModel.streamTurn(request).pipe(Metrics.Turn.tokenTotals) // this generation
Loop.loop(initial, body).pipe(Metrics.Turn.tokenTotals) // the whole loop
```

`tokenTotals` emits both this turn's `usage` and the `cumulative` total across
every turn it has seen, so on a loop the latest sample is always the running
total.

## Send it to your dashboard

To export instead of (or alongside) logging, record the same events into
metric instruments and provide an OTLP layer. Nothing about the meters
changes - you add a sink:

```ts
import * as Telemetry from "@effect-uai/core/Telemetry"

metered
  .pipe(Telemetry.record({ attributes: { model: request.model } }), Stream.runDrain)
  .pipe(Effect.provide(Telemetry.layerOtlp({ url: "http://localhost:4318/v1/metrics" })))
```

`layerOtlp` leaves the `HttpClient` to your runtime, so provide
`NodeHttpClient` / `FetchHttpClient` at the edge.

## Measure your own thing

`makeEvent` mints a custom metric event - a tool-latency timer, a cost gauge,
anything. Emit it from your own operator and the same `record` exports it,
with no change to the recorder:

```ts
Metrics.makeEvent({
  _tag: "ToolLatency",
  turnIndex: 0,
  measurements: [{ name: "tool_latency", kind: "timer", value: Duration.millis(elapsed) }],
})
```

## Write your own meter

Every latency meter is the same shape: a boundary that ends a segment, an
anchor the clock starts at, and a predicate it stops on. `Metrics.Meter` is
that plumbing with no knowledge of any capability, and the built-ins are it
plus predicates:

```ts
Metrics.Meter.timeToFirst({
  anchor: Metrics.Meter.Anchor.Element({ matches: isMyStart }),
  first: (ev) => (isMyEnd(ev) ? Option.some(ev) : Option.none()),
  boundary: isMySegmentEnd,
  event: ({ elapsed, segmentIndex }) => Metrics.makeEvent({ ... }),
})
```

`Anchor` covers the four ways a clock starts: `Request` (stream
initialization), `FirstEvent`, `Element` (the most recent matching element),
and `Mark` (an instant you stamped with `Metrics.Meter.mark`, for a start the
measured stream cannot see). A segment whose anchor never arrived reports
nothing rather than a number measured from the wrong place.

## See it run

The [basic metrics recipe](/recipes/basic-metrics/) meters a long Gemini
generation end to end - story to a file, metrics to the log.
