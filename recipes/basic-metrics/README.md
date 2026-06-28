---
title: Basic metrics
description: Measure a streaming generation with effect-uai. Stack time-to-first-token, live throughput, token totals, and completion time onto the token stream as plain operators, and log them while the output streams to a file.
source: recipes/basic-metrics
icon: PiGauge
---

When you stream a model turn, you usually want to know how it is going while
it goes: how long until the first token, how fast tokens are coming, how many
you spent, how long the whole thing took. effect-uai exposes each of these as
a small **stream operator** you stack onto a generation. They emit typed
`MetricEvent`s interleaved with the model's own events, at their own cadence,
and pass everything else through untouched.

**Scenario.** Ask Gemini Flash for a very long (≈20 page) fantasy story. The
story streams to a file; the only thing we log is the metrics.

## Attach the meters

The recipe builds one long generation and pipes it through
`Metrics.allMetrics`, which stacks all four built-in meters. Throughput is
configured in _tokens_ per second using a 4-characters-≈-1-token estimate
(the library ships no tokenizer, and a live rate cannot use the provider's
authoritative count, which only arrives at the end):

```ts
LanguageModel.streamTurn({
  model: cfg.model,
  history: [Items.systemText(SYSTEM_PROMPT), Items.userText(cfg.prompt)],
  maxOutputTokens: cfg.maxOutputTokens,
}).pipe(
  Metrics.allMetrics({
    throughput: { every: "1 second", unit: "token", tokenizer: estimateTokens },
  }),
)
```

`allMetrics` is just sugar for stacking the four operators; pick a subset by
piping them yourself (`Metrics.timeToFirstToken()`, `Metrics.tokenTotals`,
...). Each meter widens the stream with its own event and leaves the story
deltas alone.

## Split text from metrics

The metered stream carries two kinds of element: the model's `TurnEvent`s
(including `TextDelta`, the story text) and the `MetricEvent`s. The runner
tells them apart with the structural guard `Metrics.isMetricEvent` and routes
each: story deltas are written to a scoped file handle as they arrive (so the
20 pages are never buffered in memory), metric samples are logged.

```ts
fantasyStory(cfg).pipe(
  Stream.runForEach((event) =>
    Metrics.isMetricEvent(event)
      ? logMetric(event)
      : event._tag === "TextDelta"
        ? Effect.asVoid(file.write(encoder.encode(event.text)))
        : Effect.void,
  ),
)
```

A typical run logs something like:

```
TTFT        420ms (text)
throughput  ~180 token/s
throughput  ~205 token/s
throughput  ~198 token/s
...
tokens      in=24 out=13180 total=13204
completed   71.4s total, 71.0s generating
```

`TTFT` fires the instant the first token lands. `throughput` ticks once a
second while the model writes. `tokens` and `completed` land together when the
turn finishes; `tokens` are the provider's authoritative counts, so the final
token figure is exact even though the live throughput was estimated.

## Run it

```bash
GOOGLE_API_KEY=... pnpm tsx recipes/basic-metrics/run-node.ts

# override the story, model, or output path:
PROMPT="a story about a clockwork dragon" OUTPUT_FILE=dragon.txt \
  GOOGLE_API_KEY=... pnpm tsx recipes/basic-metrics/run-node.ts
```

The same `app.ts` runs under Bun (`run-bun.ts`) and Deno (`run-deno.ts`); only
the platform `HttpClient` + `FileSystem` differ.

## Where to go next

- **Export instead of log.** `Telemetry.record()` records the same
  `MetricEvent`s into effect `Metric` instruments, and `Telemetry.layerOtlp`
  ships them to an OTLP backend. The meters do not change; you add a sink.
- **Custom metrics.** `Metrics.makeEvent` mints your own branded metric event
  (a tool-latency timer, a cost gauge, ...) that the same recorder exports
  with no changes.
- **Real tokens.** Replace the `estimateTokens` heuristic with a tokenizer
  (for example `@huggingface/transformers`) for exact live token rates.
