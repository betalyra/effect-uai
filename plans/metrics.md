# Streaming metrics. design proposal

Status: draft / for discussion. Proposes small, composable metric
building blocks that attach to a `TurnEvent` stream, emit per-turn
performance samples downstream (frontend-friendly), and optionally feed
an OTLP exporter, all without consuming or reshaping the stream they
measure.

Scope: latency and throughput telemetry (time to first token,
tokens/second, per-turn token counts). Cost and cross-capability usage
normalization are a separate concern, already drafted in
[usage-tracking.md](usage-tracking.md). This plan reuses the existing
[`Items.Usage`](../packages/core/src/domain/Items.ts) shape for token
counts and does not invent a new one.

## 1. The problem

[`observability/Metrics.ts`](../packages/core/src/observability/Metrics.ts)
ships three generic stream operators: `withElapsed`, `timeToFirst`,
`withRate`. They work, but they have three gaps against what we actually
want:

1. **Not turn-aware.** They measure a whole stream from first pull to
   completion. An agent loop emits many turns on one stream (delimited by
   `TurnComplete`), so "time to first token" needs to reset per turn and
   "tokens/second" needs the per-turn generation window, not the whole-run
   average.
2. **No authoritative token source.** `withRate` asks the caller for a
   `weight` function and suggests counting tokens from `TextDelta` text
   with a tokenizer we do not ship. But every `TurnComplete` already
   carries provider-reported `usage` (`input_tokens`, `output_tokens`,
   `total_tokens`, `output_tokens_details.reasoning_tokens`,
   `input_tokens_details.cached_tokens`). For counts we should use that,
   not re-tokenize.
3. **No export path.** There is no bridge from these stream operators to
   effect's `Metric` instruments or the OTLP exporter, so nothing leaves
   the process.

Two consumers want this data and they are not the same consumer:

- A **frontend / UI** wants live per-turn samples (a "142 tok/s, TTFT
  310ms" badge), ideally as ordinary events flowing through the same
  stream so they can ride the existing SSE/JSONL transport.
- An **operator** wants aggregates (p95 TTFT, total output tokens) shipped
  to an OTLP backend (Grafana, Honeycomb, etc.).

These two have different shapes and lifetimes, so the design separates
them into two layers.

## 2. Two layers

```
       Stream<TurnEvent>  (or loop output: Stream<InteractionEvent>)
                        │
   ┌────────────────────┴────────────────────┐  layer 1: measurement
   │  opt-in meters, stacked in any order:    │  (pure streams, no services)
   │   .timeToFirstToken .throughput          │
   │   .tokenTotals      .timeToCompletion    │
   └────────────────────┬────────────────────┘
                        │  Stream<… | MetricEvent>   (events at their own cadence)
              ┌─────────┴─────────┐
              │                   │
       frontend / SSE        Telemetry.record   layer 2: export
       (filter MetricEvent)       │             (effect Metric + OTLP)
                                  ▼
                          OTLP exporter layer
```

- **Layer 1, `Metrics` (measurement).** A set of independent, opt-in stream
  operators (one per metric). Each watches the event stream, emits its own
  `MetricEvent` variant at its own cadence (eager / periodic / terminal),
  and passes everything else through. No dependency on effect `Metric` or
  OTLP. This is the "emit events downstream" half: a frontend just filters
  for `MetricEvent`. You compose only the metrics you want.
- **Layer 2, `Telemetry` (export).** A sink stream operator that consumes
  `MetricEvent`s and records them into effect `Metric` instruments
  (counters / histograms), plus a thin re-export of the OTLP metrics layer
  so the wiring is one import. This is the "observability" half.

You can use layer 1 alone (frontend only, zero observability deps), layer
2 alone, or both. They compose because layer 2 reads the same
`MetricEvent` that layer 1 emits.

## 3. Layer 1: measurement (`observability/Metrics.ts`)

### 3.1 No combined record. One independent meter per metric

Drop the single `TurnMetrics` record. Each metric is its own small stream
operator that the caller opts into, emits its own sample event at its own
cadence, and is added without touching the others. This is what makes the
set extensible (a new metric is a new operator) and subset-able (you pipe
in only what you want):

```ts
streamTurn(request).pipe(
  Metrics.timeToFirstToken, // emits the instant the 1st token lands
  Metrics.throughput({ every: "500 millis" }), // emits a live rate every 500ms
  Metrics.tokenTotals, // emits running totals at each TurnComplete
  Metrics.timeToCompletion, // emits per-turn wall time at TurnComplete
)
```

Each operator widens the element type with its own `MetricEvent` variant
and passes everything else through. They stack in any order.

`MetricEvent` is **open and user-extensible**, not a closed enum the
exporter knows. The recordable contract is structural: any value carrying a
brand marker and a list of **self-describing measurements** is a metric
event, whether it is one of ours or one a user mints (section 4.4). The
exporter reads only `measurements` and never matches a tag:

```ts
export const MetricEventTypeId: unique symbol = Symbol.for("@effect-uai/core/MetricEvent")

export interface Measurement {
  readonly name: string
  readonly kind: "counter" | "histogram" | "timer" | "gauge"
  readonly value: number | Duration
  readonly attributes?: Metric.Attributes
}

// the structural contract every metric event satisfies (ours and custom)
export interface MetricEvent {
  readonly [MetricEventTypeId]: typeof MetricEventTypeId
  readonly _tag: string // free-form; namespaced per metric
  readonly turnIndex: number // which turn within the piped stream
  readonly measurements: ReadonlyArray<Measurement>
}

// built-ins are just MetricEvents with extra typed fields for frontends
export interface TimeToFirstToken extends MetricEvent {
  readonly _tag: "TimeToFirstToken"
  readonly elapsed: Duration
  readonly kind: "text" | "reasoning" // which delta arrived first
}
export interface Throughput extends MetricEvent {
  readonly _tag: "Throughput"
  readonly ratePerSecond: number
  readonly unit: "char" | "token" | "event"
  readonly window: Duration
}
export interface TokenTotals extends MetricEvent {
  readonly _tag: "TokenTotals"
  readonly usage: Usage
  readonly cumulative: Usage
}
export interface TimeToCompletion extends MetricEvent {
  readonly _tag: "TimeToCompletion"
  readonly duration: Duration
  readonly generation: Duration
}

// constructor that stamps the brand; the only way users mint a custom event
export const makeEvent: (fields: Omit<MetricEvent, typeof MetricEventTypeId>) => MetricEvent

// structural guard: brand presence, NOT an enumerated tag list
export const isMetricEvent: (u: unknown) => u is MetricEvent
```

The **`_tag` + typed fields** serve a frontend that wants `e.ratePerSecond`
with full types; the **brand + `measurements`** serve the exporter, which
iterates blindly. A new built-in metric, or a user's own, is just another
`MetricEvent`; the exporter (section 4) does not change.

The brand (not the `_tag`) is what `isMetricEvent` checks, so metric events
are distinguished from `TurnEvent`s, tool outputs, and arbitrary custom
loop values regardless of what `_tag` string a user picks. The existing
`_tag` filters (`Turn.textDeltas`, `isTurnComplete`, `Turn.toSSE`/`toJSONL`)
do not match these tags, so they pass through untouched.

### 3.2 The metric catalogue (initial set)

| Operator                | Cadence                          | Source                           | Sample event       |
| ----------------------- | -------------------------------- | -------------------------------- | ------------------ |
| `timeToFirstToken`      | eager: on 1st content delta      | none (timing only)               | `TimeToFirstToken` |
| `throughput({ every })` | periodic: every `Duration`       | live `unit` estimate (3.3)       | `Throughput`       |
| `tokenTotals`           | terminal: on each `TurnComplete` | provider `usage` (authoritative) | `TokenTotals`      |
| `timeToCompletion`      | terminal: on each `TurnComplete` | none (timing only)               | `TimeToCompletion` |

Cadence is the point: TTFT fires the moment the model starts producing,
throughput streams a live number for a frontend gauge, and the two totals
land when the turn closes. Nothing waits for a metric it does not need.

- **`timeToFirstToken`** starts its clock when the request is sent (the
  stream is initialized, section 3.3) and emits a `TimeToFirstToken` the
  instant it sees the first `TextDelta` or `ReasoningDelta`, carrying
  `kind: "text" | "reasoning"` so the frontend knows which arrived first.
  Reasoning-first models report time-to-first-reasoning, the honest "time
  until the model started".
- **`timeToCompletion`** emits at `TurnComplete` with `duration` (request
  send to complete) and `generation` (first token to complete, the decode
  window). Final throughput, if wanted, is `usage.output_tokens /
generation` and can be derived by the consumer or added as a field.
- **`tokenTotals`** reads provider `usage` off each `TurnComplete`. It
  emits both `usage` (this turn) and `cumulative` (summed over every
  `TurnComplete` seen so far on this stream), which is the hook for scope
  (section 3.4). Source is the provider `usage` fields, nothing else; if a
  provider reports no usage (some diffusion models, for example) the fields
  stay absent, faithfully. A library-side token estimator for those
  providers can be added later if needed; out of scope for now.

**Batteries-included helper.** Since the meters are just composable
operators, ship one convenience that pipes them all together for the common
"give me everything" case. Make it (and `Telemetry.record`) **dual** so it
can be used bare in a pipe, or called with options, by detecting whether
the first argument is a `Stream` (the pattern Effect uses widely):

```ts
export const allMetrics: {
  // bare: pipe(self, Metrics.allMetrics) -> defaults
  <A, E, R>(self: Stream<A, E, R>): Stream<A | MetricEvent, E, R>
  // configured: pipe(self, Metrics.allMetrics({ throughput: { unit: "token", tokenizer } }))
  (options: {
    readonly throughput?: ThroughputOptions
  }): <A, E, R>(self: Stream<A, E, R>) => Stream<A | MetricEvent, E, R>
}
// = self.pipe(timeToFirstToken, throughput(options?.throughput ?? { every: "1 second" }),
//             tokenTotals, timeToCompletion)
```

So both the bare and configured forms read cleanly, no mandatory `()`:

```ts
pipe(streamTurn(request), Metrics.allMetrics, Telemetry.record) // bare, defaults
pipe(
  streamTurn(request),
  Metrics.allMetrics({ throughput: { unit: "token", tokenizer } }),
  Telemetry.record({ attributes: { model } }),
) // configured
```

The zero-config meters (`timeToFirstToken`, `tokenTotals`,
`timeToCompletion`) are already plain `(self) => self2` operators, so they
also pipe bare. `throughput` defaults `every`, so it too can be bare when
the defaults suit. `allMetrics` only bundles the built-ins; user-defined
metrics (section 4.4) drop into the same pipe alongside it.

### 3.3 Cadence mechanics

- **Eager (`timeToFirstToken`).** A single pass with a small `Ref`
  accumulator. The clock starts at **stream initialization**, not at the
  first emitted event, which is the crux for TTFT (3.3.1): on first content
  delta of a turn, read `Clock`, emit, mark done-for-this-turn; reset on
  `TurnComplete`.
- **Terminal (`tokenTotals`, `timeToCompletion`).** Compute at
  `TurnComplete`, emit the original `TurnComplete` followed by the sample,
  reset per turn.
- **Periodic (`throughput`).** This one needs a clock-driven tick
  independent of stream pulls. Build it as a scoped merge of two streams
  sharing a `Ref<{ units, lastUnits, lastMillis }>`: the source stream adds
  this event's unit count to the accumulator per delta and passes events
  through; a metronome (`Stream.repeatEffect` on `Schedule.spaced(every)`,
  scoped to the generation window so it does not tick during tool calls or
  after `TurnComplete`) reads the accumulator and emits a `Throughput`. Use
  `Stream.merge`. The tick fiber is interrupted at `TurnComplete` and
  restarted on the next turn.

  Full options, all configurable with the defaults noted:

  ```ts
  Metrics.throughput(options: {
    readonly every: Duration.Input                       // tick interval; default "1 second"
    readonly unit?: "char" | "token" | "event"           // default "char"
    readonly tokenizer?: (event: TurnEvent) => Effect<number>  // token COUNT; unit:"token" only
    readonly mode?: "windowed" | "cumulative"            // default "windowed"
    readonly smooth?: "default" | number                 // omitted = off; "default" ~ 0.3
  })
  ```

  **What a "unit" is (`unit` + `tokenizer`).** The `unit` _is_ the counting
  strategy, so there is no separate `weight`. Provider deltas are not
  uniform: some stream token by token, some (Gemini) emit a multi-token
  phrase per event, so the meter never silently mislabels:
  - `char` (default): counts characters of emitted `TextDelta` text (Unicode
    code points via `[...text].length`, so astral chars and emoji count as
    one rather than the two UTF-16 units `text.length` would give). Exact
    and chunking-independent, so honest on every provider out of the box.
  - `event`: counts 1 per content delta. Exact, crude.
  - `token` with `tokenizer`: counts `tokenizer(event)` (a token _count_, an
    `Effect<number>` because real tokenizers load/run async). The tokenizer
    is out of scope for this package; we document wiring an external one (for
    example `@huggingface/transformers`) in the throughput docs.
  - `token` without `tokenizer`: approximate, 1 per content delta. Honest
    only for token-by-token providers; documented as an estimate. (Absence
    of a tokenizer is the "implicit" path, no magic literal.)

  The tokenizer returns a _count_, not the tokens themselves: throughput
  only needs the number, and tokenizing every delta is already the hot-path
  cost. The emitted `Throughput` carries `unit`, and the OTLP metric name is
  derived from it (`effect_uai_output_chars_per_second` vs
  `_tokens_per_second` vs `_events_per_second`), so a frontend and a
  dashboard always know which unit they show. Provider `usage` only lands at
  `TurnComplete`, so the live rate is always an estimate; the authoritative
  totals come from `tokenTotals` at the boundary. (This subsumes the
  existing generic `withRate`.)

  **Rate definition (`mode` + `smooth`).** Default `windowed`: each tick
  reports `unitsInLastInterval / intervalSeconds`, so the gauge reflects
  current speed with no cold-start bias. `cumulative` reports
  `unitsSoFar / elapsedSinceFirstToken` (smoother but biased by history, so
  a slow start drags it down for a long time). Either mode can be smoothed
  by `smooth` (EWMA: `avg = a*instant + (1-a)*avg`, where `"default"` picks
  a sensible `a` and a number sets it) to damp the jitter windowed mode
  shows when a provider emits chunky deltas. `Throughput.window` carries the
  interval the rate was computed over (the tick interval in windowed mode).

Performance (per [perf-over-elegance memory]): the eager/terminal hot path
is one branch per event plus a `Clock` read on boundary events only, not
per delta. `throughput` adds one `Ref` update per counted delta (plus the
tokenizer call when `unit: "token"`).

#### 3.3.1 When the TTFT clock starts (request send, not first event)

TTFT must measure request-send to first token. The subtlety: the stream may
emit nothing before the model responds (or an early lifecycle event like
Anthropic's `message_start` usage), so anchoring on the "first emitted
event" would either read ~0 or anchor on the wrong thing. The fix is to
start the clock at **stream initialization**: a meter's `Stream.unwrap` /
`mapAccumEffect` initializer runs on the first pull, which is exactly when
`streamTurn`'s provider request fires. So `start = Clock at init`, measured
against the first content delta, captures true request-to-first-token. This
is the same mechanism the existing `withElapsed` already uses.

Make it configurable, defaulting to request-send:

```ts
Metrics.timeToFirstToken // default: from "request"
Metrics.timeToFirstToken({ from: "first-event" }) // exclude connect/queue latency
```

- `"request"` (default): clock from stream init. Includes connection +
  provider queue + prefill, which is what a user perceives as latency.
- `"first-event"`: clock from the first emitted event, isolating decode-only
  latency when an early lifecycle event exists.

**Loop scope caveat.** This is exact when the meter initializes per request,
i.e. attached at `streamTurn` scope (`streamTurn(req).pipe(timeToFirstToken)`),
which is the normal place and the recommended one for the timing meters.
When attached to a whole-loop output stream, the meter initializes once, so
per-turn TTFT for turns after the first measures from the previous
`TurnComplete` and therefore includes the inter-turn tool time, not just
request latency. The guidance is therefore: attach the timing meters
(`timeToFirstToken`, `timeToCompletion`, `throughput`) at `streamTurn`
scope, and attach cumulative `tokenTotals` at loop scope; they compose in
different spots of the same loop. A single loop-output attach that nails
per-turn TTFT would need an explicit per-turn request marker, which is the
lifecycle-events question in section 3.5; the conclusion there is to not add
one for now.

### 3.4 Scope: turn vs loop, for free

The ask: a metric piped from `streamTurn` reports per generation; the same
metric piped from the loop reports for the whole loop. This needs no
type-level scope detection, because **the stream's extent is the scope**:

- The meters are generic over the element type, scanning for the
  `TurnEvent` variants they care about (`_tag === "TurnComplete"`, etc.)
  and passing everything else (tool outputs, custom loop values) through.
  So the same operator attaches to `streamTurn`'s `Stream<TurnEvent>` and
  to the loop's output `Stream<InteractionEvent>` alike. (Confirmed: `loop`
  emits the body's `Value` payloads, and the canonical `onTurnComplete`
  body forwards `TurnComplete`, so loop output carries `TurnComplete`
  elements.)
- A **cumulative** meter (`tokenTotals.cumulative`) sums over every
  `TurnComplete` it sees. Pipe in one turn and the running total is that
  generation; pipe in the loop and it is the whole loop, updated each turn.
  The latest emission is always the correct scope total, no waiting for
  stream end.
- **Per-turn** meters (`timeToFirstToken`, `timeToCompletion`, per-turn
  `tokenTotals.usage`) emit once per turn, tagged with `turnIndex`. One
  emission on a single turn, N on a loop. The frontend attributes each by
  index.

So the operator does not introspect whether it sits on a turn or a loop;
it aggregates over whatever you hand it. That is strictly more flexible
than a type flag (it also works on a sub-range of a loop, a filtered
stream, etc.). The signature is just:

```ts
export const tokenTotals: <A, E, R>(
  self: Stream.Stream<A, E, R>,
) => Stream.Stream<A | MetricEvent, E, R>
```

If you specifically want to _guarantee_ a single-generation measurement
regardless of what you pipe, wrap the producer (section 5, option B); that
is the only case where turn-vs-loop needs to be pinned by construction.

### 3.5 On lifecycle events (turn/loop start and end)

Should the library emit explicit `TurnStart` / `TurnComplete` and
`LoopStart` / `LoopEnd` events? The metrics design surfaced this (3.3.1),
but it is really a broader architecture question. The recommendation is
**no, not now**, split by layer:

- **Turn end already exists** as `TurnComplete`. **Turn start does not.** A
  `TurnStart` (emitted when the request fires) is the one genuinely missing
  primitive, and it has a real use: it would let a single loop-output attach
  measure per-turn TTFT correctly, and gives a frontend a clean "generation
  started" signal. But it is a synthetic event (not provider data) with wide
  blast radius: it joins the `TurnEvent` ADT, so every `_tag` filter,
  `Turn.toSSE`/`toJSONL`, and provider adapter (or a central prepend in the
  `streamTurn` module export) has to account for it. For the metrics we
  ship, the clock-at-init mechanism (3.3.1) already covers TTFT at the
  normal `streamTurn` attach scope, so `TurnStart` buys only the loop-scope
  case. Defer it; if loop-scope TTFT or explicit turn spans become a real
  need, add it then, emitted at request-fire, as the clean shape.

- **Loop start/end as events: lean no.** A loop _is_ a `Stream`; its
  boundaries are the stream's boundaries. "Loop started" is the first pull,
  "loop ended" is `Cause.done` / stream completion, and setup/teardown
  belong in `Stream.ensuring` / `acquireRelease`, not in injected events.
  Modelling them as in-band events fights the "an agent loop is an ordinary
  stream" design and adds artificial elements every consumer must skip. The
  one place an explicit marker helps is a **remote** consumer that only sees
  serialized bytes (SSE/JSONL) and cannot observe the Effect stream
  lifecycle; there, a wire-level start/end sentinel is a transport concern,
  best handled in the SSE/JSONL mapping (the `modify-output-stream` recipe),
  not baked into the core `Loop` primitive.

Net: keep the stream lean. Do not add lifecycle events for the metrics work;
treat `TurnStart` as a well-understood future addition with one concrete
trigger (loop-scope TTFT), and leave loop boundaries to the stream itself.

### 3.6 Generic primitives and helpers

`withElapsed`, `timeToFirst`, `withRate` stay as lower-level,
capability-agnostic building blocks; they also serve non-LLM streams
(music audio chunks, transcription events). The new meters are the
`TurnEvent`-aware entry points.

```ts
// isMetricEvent is the structural (brand-based) guard from 3.1.
// pull just the samples out, for a side channel / frontend feed:
export const metricEvents: <A, E, R>(s: Stream<A | MetricEvent, E, R>) => Stream<MetricEvent, E, R>
```

## 4. Layer 2: export (`observability/Telemetry.ts`, new)

The user requirement here is that **the exporter is agnostic to which
metrics exist**: adding a metric later, or a caller enabling only a
subset, must not touch the exporter. This rules out a hardcoded list of
instruments. The design is a generic recorder driven by the
`measurement.kind` + `measurement.name`, leaning on a fact verified in
effect-smol's `Metric` internals.

### 4.1 Why a generic recorder works: lazy instruments dedupe by name

`Metric.counter(name)` (and friends) do not allocate fresh state per call.
`getOrCreate` keys the global `MetricRegistry` by
`type:id:description:attributes` ([Metric.ts](../../effect-smol/packages/effect/src/Metric.ts)
`makeKey`), so two `Metric.counter("x")` with equal name+attributes share
one registered metric, and updates accumulate. The OTLP exporter snapshots
that same registry. Consequences:

- We can **create an instrument on demand** from a `Measurement`'s
  `(kind, name)` and update it; the registry dedupes, so repeated turns hit
  the same series.
- The exporter ships **whatever is in the registry**, so a metric that no
  meter ever emits simply never exists, and a new meter's metric appears
  the first time it fires. No registration step, no central enum.

A tiny `Map<string, Metric>` cache in the recorder avoids reconstructing
the wrapper object per event (perf, not correctness; the registry would
dedupe anyway).

### 4.2 The recorder

```ts
const instrumentFor = (m: Measurement): Metric<number | Duration, any> => {
  switch (m.kind) {
    case "timer":
      return Metric.timer(m.name) // Duration -> ms histogram
    case "histogram":
      return Metric.histogram(m.name, { boundaries })
    case "counter":
      return Metric.counter(m.name, { incremental: true })
    case "gauge":
      return Metric.gauge(m.name)
  }
}

// records every measurement on every MetricEvent; never matches _tag.
// dual, like Metrics.allMetrics: usable bare or with options.
export const record: {
  <A, E, R>(self: Stream<A | MetricEvent, E, R>): Stream<A | MetricEvent, E, R>
  (options: { readonly attributes?: Metric.Attributes }): // e.g. { model, provider }
  <A, E, R>(self: Stream<A | MetricEvent, E, R>) => Stream<A | MetricEvent, E, R>
}
```

It is a `Stream.tap` that, for each element matching `isMetricEvent` (the
brand guard, so it catches built-in and custom events alike), walks
`e.measurements` and for each one looks up (or builds and caches) the
instrument by `kind+name`, applies `options.attributes` and the
measurement's own `attributes` via `Metric.withAttributes`, and calls
`Metric.update`. It dispatches on `measurement.kind`, never on the event
`_tag`, so **a new built-in or custom metric needs zero changes here**.
Events pass through untouched so `record` sits mid-pipeline before the
transport.

The naming convention (`effect_uai_*`) and the histogram boundaries live in
the meters that emit the measurements (layer 1), not here, keeping the
exporter free of metric-specific knowledge.

### 4.3 OTLP wiring

effect-smol already ships the exporter
([`OtlpMetrics`](../../effect-smol/packages/effect/src/unstable/observability/OtlpMetrics.ts)).
We do not wrap it; we document and optionally re-export a convenience
layer so users get one import:

```ts
// Telemetry.ts
export const layerOtlp = (options: {
  readonly url: string
  readonly resource?: { serviceName?: string; serviceVersion?: string }
}): Layer<never, never, never> =>
  OtlpMetrics.layer(options).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  )
```

Caller surface end to end:

```ts
const program = LanguageModel.streamTurn(request).pipe(
  Metrics.timeToFirstToken, // layer 1: pick the
  Metrics.throughput({ every: "500 millis" }), //   metrics you want
  Metrics.tokenTotals,
  Telemetry.record({ attributes: { model: "..." } }), // layer 2: record all
  Stream.runForEach(handleEvent), // your consumer
)

program.pipe(
  Effect.provide(Telemetry.layerOtlp({ url: "http://localhost:4318/v1/metrics" })),
  Effect.provide(SomeLanguageModelLayer),
)
```

The frontend variant just drops layer 2 and filters:

```ts
LanguageModel.streamTurn(request).pipe(
  Metrics.throughput({ every: "500 millis" }),
  Stream.runForEach((e) =>
    Metrics.isMetricEvent(e)
      ? e._tag === "Throughput"
        ? pushRate(e.ratePerSecond, e.unit)
        : pushBadge(e)
      : renderDelta(e),
  ),
)
```

Note `FetchHttpClient` is illustrative; provide the platform's HttpClient
(NodeHttpClient etc.) at the edge like the OTLP tracing example does.

### 4.4 Custom and user-defined metrics

Because the recorder is structural (4.2), a user-defined metric exports
with **no changes to the exporter**. A custom metric is just a stream
operator the user writes that emits `MetricEvent`s via `makeEvent` (3.1).
Three kinds all work:

- **A brand-new metric.** Watch the stream, compute something, emit a
  branded event carrying its measurements:

  ```ts
  const toolLatency = <A, E, R>(self: Stream<A, E, R>) =>
    self.pipe(Stream.mapAccumEffect(/* ... */, (s, e) =>
      isToolCallOutput(e)
        ? Effect.map(Clock.currentTimeMillis, (now) => [s, [e, Metrics.makeEvent({
            _tag: "ToolLatency", turnIndex: s.turnIndex,
            measurements: [{ name: "myapp_tool_latency", kind: "timer",
                             value: Duration.millis(now - s.startedAt) }],
          })]])
        : Effect.succeed([s, [e]])))
  ```

  Pipe it alongside the built-ins; `Telemetry.record` ships
  `myapp_tool_latency` to OTLP automatically, and a frontend sees it via
  `isMetricEvent`.

- **A composed / derived metric.** Consume the built-in events and emit a
  new one. For example a "cost" meter that reads each `TokenTotals` and a
  price card, emitting a `Cost` event with a `gauge`/`counter` measurement.
  This is an ordinary `Stream` operator over `MetricEvent`s, so it composes
  in the same pipe.

- **A relabeled built-in.** Add extra `measurements` or attributes by
  mapping over the built-in events before `record`.

The only contract a custom event must honor: carry the brand (use
`makeEvent`) and a well-formed `measurements` array whose `kind` is one of
the four the recorder maps (4.2). New `Measurement.kind`s would be the one
thing requiring an exporter change; the four cover counter / gauge /
histogram / timer, which is the whole of what OTLP metrics expresses, so in
practice users never need a new kind.

For a custom metric the user wants in their own OTLP backend with bespoke
boundaries or descriptions, they can also skip `makeEvent` and update their
own `Metric` instrument directly in the operator; `record` is a
convenience, not a requirement. Either path lands in the same registry the
OTLP layer exports.

## 5. Scope: polymorphic by default, pinnable when needed

The earlier "force metrics to the turn level via types" framing is
superseded by the newer goal: the same meter should report per generation
on `streamTurn` and per loop on the loop stream (section 3.4). That is now
the **default**, achieved without type machinery by aggregating over the
stream's extent. So most callers need nothing here.

The remaining, narrower want: sometimes you do want to _guarantee_ a
single-generation measurement no matter what stream is handed in (e.g. a
reusable helper that must not silently become loop-scoped). That is the
only case for pinning scope by construction. Three options.

### Option A: scope follows the stream (default, recommended)

`tokenTotals: Stream<A> => Stream<A | MetricEvent>` and friends, as in
section 3.4. Scope = what you pipe in. Zero type machinery, works on turn,
loop, or any sub-range. This is the default and covers the user's
turn-or-loop ask directly.

### Option B: pin single-turn by wrapping the producer

When you need the guarantee, make metering a transformer over a
turn-producing function, the exact shape of `LanguageModel.streamTurn` and
the service method (`(request) => Stream<TurnEvent>`):

```ts
export const metered: (options?: {
  attributes?: Metric.Attributes
}) => <Req, E, R>(
  streamTurn: (req: Req) => Stream<TurnEvent, E, R>,
) => (req: Req) => Stream<TurnEvent | MetricEvent, E, R>

// usage: wrap the producer, then drive the loop with the wrapped version
const tracked = Metrics.metered()(LanguageModel.streamTurn)
tracked(request).pipe(onTurnComplete(/* ... */))
```

Because you wrap the per-call producer, each measurement spans exactly one
generation _by construction_. The loop's own output is
`Stream<InteractionEvent>` / `Stream<Step<...>>`, a different shape, so you
**cannot** pass it to `metered` (type error: not a
`(req) => Stream<TurnEvent>`). A soft but real type guarantee with no brand
fragility, and it reads correctly at the call site.

Cleaner still for OTLP-only use: a `LanguageModel` **layer transformer**
that wraps the service's `streamTurn`, so metrics happen per turn inside
the service and the loop code is untouched:

```ts
export const withMetrics: (
  options?,
) => (layer: Layer<LanguageModel, E, R>) => Layer<LanguageModel, E, R>
```

Per-turn by construction. Trade-off: the service interface returns
`Stream<TurnEvent>`, so this path records to OTLP (and/or a side channel)
but cannot widen the stream to carry `MetricEvent` to a frontend. Use the
producer form (B) when you want events in the stream, the layer form when
you only want export.

### Option C: branded `TurnStream` (airtight, not recommended)

Brand the result of `streamTurn` as `TurnStream = Stream<TurnEvent> &
Brand<"TurnStream">` and have the meters require the brand. Airtight, but
Stream combinators return plain `Stream` and drop the brand, so you could
only meter as the very first operation and never after a `map` / `filter`
on the turn stream. It also kills the scope polymorphism of Option A. The
ergonomic tax is not worth it; noted for completeness.

### Interaction with where MetricEvents flow

Whichever option, the meters emit `MetricEvent` _into_ the stream, so
turn-stream consumers must tolerate the extra member. `isTurnComplete` /
`textDeltas` already ignore it at runtime (distinct `_tag`), but
`onTurnComplete`'s signature is `Stream<TurnEvent, ...>` and would need to
widen to `Stream<TurnEvent | X>` passing `X` through. That is a small,
contained change to one operator. If we would rather not touch
`onTurnComplete`, the alternative is a **side channel**: the meter records
to OTLP (and optionally publishes samples to a scoped `PubSub`/`Queue` the
frontend subscribes to) and leaves the `TurnEvent` stream pure-typed. See
open question 8.

Recommendation: ship **Option A** as the default (it answers the
turn-or-loop ask), offer the **Option B producer form** for the pin-it
case (and widen `onTurnComplete` once), plus the **layer transformer** for
zero-touch OTLP. Skip C.

## 6. File layout

```
packages/core/src/observability/
  Metrics.ts      # layer 1: generic primitives + per-metric meters + MetricEvent (extend existing)
  Telemetry.ts    # layer 2: generic recorder + layerOtlp (new)
```

Both re-exported as namespaces from
[`core/src/index.ts`](../packages/core/src/index.ts):

```ts
export * as Metrics from "./observability/Metrics.js"
export * as Telemetry from "./observability/Telemetry.js"
```

Keeping them in `@effect-uai/core` (not a new package) since they are tiny
and depend only on the domain `Turn`/`Usage` types plus effect itself.

## 7. Testing

- **Cadence, with `TestClock`.** Drive a scripted event stream and assert
  _when_ each sample fires: `timeToFirstToken` emits right after the first
  content delta (not at `TurnComplete`); `throughput({ every })` emits once
  per interval as the clock advances; `tokenTotals` / `timeToCompletion`
  emit at `TurnComplete`. Advance the clock between events and assert the
  values exactly. No network, deterministic.
- **Scope.** Same meter over a single-turn stream vs a two-`TurnComplete`
  stream: assert `tokenTotals.cumulative` equals the one turn's usage in
  the first case and the sum in the second, and that per-turn meters emit
  once vs twice with incrementing `turnIndex`.
- **`throughput` rate + unit.** Assert `windowed` reports last-interval
  rate and `cumulative` reports since-first-token rate, that `smooth` damps
  a jittery sequence, and that `unit` flows onto the event and the derived
  metric name. With a stubbed `tokenizer` assert `unit: "token"` counts via
  it; feed Gemini-style multi-token chunks and assert the default `char`
  unit is correct where an event count would not be.
- **`Telemetry.record` agnosticism.** Feed built-in events, then a
  `makeEvent`-built **custom** event with a novel `_tag` and metric name,
  and assert via `Metric.snapshot` that the custom instrument was created
  and moved. This is the regression test that the exporter stays agnostic.
- **Type-level.** `expectTypeOf` that each meter widens the element type by
  its `MetricEvent` variant, that meters stack (`A | E1 | E2`), that
  `makeEvent` output is assignable to `MetricEvent`, and that existing
  operators (`Turn.textDeltas`) still accept the widened stream. Inline in
  the `.test.ts`, no scratch files.

Resolved this round: 5 (smooth), 6 (metronome lifetime, implicit at
streamTurn scope), 7 (caller attributes, `turnIndex` stays off OTLP), 9
(inline, widen `onTurnComplete`), 10 (Option A only), 11 (ship `makeEvent`,
defer reducer helper).

1. **Catalogue (3.2): locked.** The four built-ins (`timeToFirstToken`,
   `throughput`, `tokenTotals`, `timeToCompletion`) are the set. Agentic
   extras (`turnCount`, `toolCallCount`, `stopReasons`, inter-token latency)
   were considered and dropped as not important enough; users can add any of
   them as a custom metric (4.4) if wanted.
2. **TTFT clock start (3.3.1): resolved.** Default `from: "request"` (clock
   at stream init = request send), configurable to `from: "first-event"`.
   Confirm the default and the `from` knob.
3. **TTFT reasoning vs text (3.2): resolved.** One `timeToFirstToken`
   firing on the first content delta with a `kind: "text" | "reasoning"`
   field, not two operators. Confirm.
4. **`throughput` unit (3.3): research done, recommend `char`.** Our
   adapters pass one provider chunk to one `TextDelta`, and providers chunk
   differently: OpenAI/Mistral one-or-few tokens, Anthropic small multi-token
   runs, Gemini whole phrases, diffusion models (Inception) whole-text. So
   event-counting mis-estimates tokens on most providers, not just Gemini.
   Recommend default `char` (exact and consistent everywhere); `token`
   requires a caller tokenizer (`Effect<number>` count); `event` available
   for the crude case. Confirm we keep `char` default over a tokens-ish
   default.
5. **`throughput` rate mode + smoothing (3.3): resolved.** `mode` default
   `windowed`, `cumulative` available; `smooth?: "default" | number`,
   omitted = off.
6. **`tokenTotals` source (3.2): resolved.** Provider `usage` only; absent
   fields stay absent. A library-side estimator for providers that report no
   usage is deferred. Separately, if
   [usage-tracking.md](usage-tracking.md) later standardizes a `Usage`/`Cost`
   shape, `tokenTotals` should reference it; keep the sample types thin.
7. **Lifecycle events (3.5): resolved for now.** Do not add `TurnStart` or
   loop start/end events for the metrics work. TTFT uses clock-at-init at
   `streamTurn` scope (3.3.1); loop boundaries stay implicit in the stream.
   `TurnStart` is recorded as a clean future addition with one concrete
   trigger (loop-scope TTFT) if it ever becomes a real need.

```

```
