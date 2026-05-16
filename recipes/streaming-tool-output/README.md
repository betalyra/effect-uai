---
title: Streaming tool output
description: Two flavors of `Tool.streaming` - sub-agent text streaming and progress + terminal result.
source: recipes/streaming-tool-output
icon: PiPulse
---

Streaming tools let the user see inner work without leaking the whole event
log back to the model.

A `Tool.streaming` returns a `Stream<Event>` from `run` and reduces the
collected events into the model-facing `Output` via `finalize`. Each inner
event flows through to the consumer as a `ToolEvent.Intermediate`; the outer
model only ever sees `finalize(events)` as the structured `Output`. Rich UI
for the user, clean data for the model.

This recipe shows two patterns side-by-side:

| Pattern           | Inner stream                   | What `finalize` does                     |
| ----------------- | ------------------------------ | ---------------------------------------- |
| Sub-agent         | `Stream<Turn.TurnEvent>`       | Joins text deltas into the answer string |
| Progress + result | `Stream<{progress \| result}>` | Ignores progress; picks the result event |

A third pattern (each event IS a result item — recipe streamer, search
hits, transcoded chunks) follows the same shape; just have `finalize`
collect events into a list.

## Pattern 1: sub-agent

The outer model calls `ask_subagent`; an inner agent runs (its own
conversation), streaming `TextDelta`s back through the executor as
`ToolEvent.Intermediate`s. The user sees the sub-agent reasoning unfold
live; the outer model receives the joined answer.

```ts
export const makeSubAgent = (runInner: (question: string) => Stream.Stream<Turn.TurnEvent>) =>
  Tool.streaming({
    name: "ask_subagent",
    description: "Ask a specialist sub-agent for help with a hard question.",
    inputSchema: Tool.fromEffectSchema(SubAgentInput),
    run: ({ question }) => runInner(question),
    finalize: (events): SubAgentOutput => ({
      answer: events
        .filter((e): e is Extract<Turn.TurnEvent, { _tag: "TextDelta" }> => e._tag === "TextDelta")
        .map((e) => e.text)
        .join(""),
    }),
    strict: true,
  })
```

`run` is parametrized over `runInner` so tests inject a mocked stream
and production passes a real inner-loop stream. `finalize` filters and
joins — the model gets a clean string, not the raw event log.

## Pattern 2: progress + terminal result

The model calls `download_artifact` (or sandboxed exec, web search,
transcoding, ...). The tool emits one `progress` event per chunk and a
single terminal `result` event. Progress events drive a UI progress
bar; the model receives one structured value at the end.

```ts
type DownloadEvent =
  | { type: "progress"; pct: number; chunk: number }
  | { type: "result"; bytes: string }

export const makeDownloadTool = (perChunkDelay: Duration.Input = "150 millis") =>
  Tool.streaming({
    name: "download_artifact",
    description: "Download bytes from a URL...",
    inputSchema: Tool.fromEffectSchema(DownloadInput),
    run: ({ url, chunks }) =>
      Stream.unfold(0, (i) => /* emit `chunks` progress events, then one result */),
    finalize: (events): DownloadOutput => {
      const result = events.find((e) => e.type === "result")
      const chunks = events.filter((e) => e.type === "progress").length
      return result
        ? { status: "completed", bytes: result.bytes, chunks }
        : { status: "failed", bytes: "", chunks }
    },
    strict: true,
  })
```

## Recipe shape

Identical to basic-usage; the only difference is the toolkit:

```ts
onTurnComplete<State, ToolEvent>((turn) =>
  Effect.sync(() => {
    const calls = Turn.functionCalls(turn)
    if (calls.length === 0) return stop

    return Toolkit.executeAll(allTools, calls).pipe(
      Toolkit.continueWith((results) =>
        Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
      ),
    )
  }),
)
```

Streaming and plain tools dispatch uniformly inside `executeAll`.

## What the consumer sees

For a single download with 3 chunks:

```
Intermediate { tool: "download_artifact", data: { type: "progress", pct: 33, ... } }
Intermediate { ...                              data: { type: "progress", pct: 67, ... } }
Intermediate { ...                              data: { type: "progress", pct: 100, ... } }
Intermediate { ...                              data: { type: "result",   bytes: "..." } }
Output       { result: ToolResult.Value(call_id, "download_artifact", { status: "completed", ... }) }
```

For the sub-agent: one `Intermediate` per inner `TextDelta` followed by
the final `Output` carrying the joined answer.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/streaming-tool-output/run.ts
```

The runner drives the download pattern (more visual demo). Tests in
`index.test.ts` cover both patterns offline using mocked inner streams.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-tool-output/index.ts).
