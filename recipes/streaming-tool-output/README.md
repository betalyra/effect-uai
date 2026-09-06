---
title: Streaming tool output
description: "Two flavors of a tool whose `run` emits events: sub-agent text streaming and progress + terminal result."
source: recipes/streaming-tool-output
icon: PiPulse
---

Streaming tools let the user see inner work without leaking the whole event
log back to the model.

The tool's `run` receives `(input, emit)`. It emits each inner event to the
consumer in real time via `emit`, and returns the single structured `Output`
the model sees. Each emitted event reaches the consumer as a
`ToolEvent.Progress`; the outer model only ever sees the value `run` returns.
Rich UI for the user, clean data for the model.

This recipe shows two patterns side-by-side:

| Pattern           | Inner stream                   | What `run` returns                       |
| ----------------- | ------------------------------ | ---------------------------------------- |
| Sub-agent         | `Stream<Turn.TurnEvent>`       | Folds text deltas into the answer string |
| Progress + result | `Stream<{progress \| result}>` | Counts progress; takes the result bytes  |

A third pattern (each event IS a result item: recipe streamer, search
hits, transcoded chunks) follows the same shape; just have `run` fold
events into a list.

## Pattern 1: sub-agent

The outer model calls `ask_subagent`; an inner agent runs (its own
conversation), streaming `TextDelta`s back through the executor as
`ToolEvent.Progress`s. The user sees the sub-agent reasoning unfold
live; the outer model receives the joined answer.

```ts
export const makeSubAgent = (
  runInner: (question: string) => Stream.Stream<Turn.TurnEvent, unknown, never>,
) =>
  Tool.make({
    name: "ask_subagent",
    description: "Ask a specialist sub-agent for help with a hard question.",
    inputSchema: Tool.fromEffectSchema(SubAgentInput),
    // Emit each inner event to the consumer in real time while folding the
    // text deltas into the model-facing answer (single pass, no buffering).
    run: ({ question }, emit) =>
      runInner(question).pipe(
        Stream.runFoldEffect(
          () => "",
          (answer, event) =>
            emit(event).pipe(Effect.as(event._tag === "TextDelta" ? answer + event.text : answer)),
        ),
        Effect.map((answer): SubAgentOutput => ({ answer })),
      ),
    strict: true,
  })
```

`run` is parametrized over `runInner` so tests inject a mocked stream
and production passes a real inner-loop stream. The fold emits each event
and joins the deltas in one pass: the model gets a clean string, not the
raw event log.

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
  Tool.make({
    name: "download_artifact",
    description: "Download bytes from a URL...",
    inputSchema: Tool.fromEffectSchema(DownloadInput),
    run: ({ url, chunks }, emit) => {
      const events = Stream.unfold(0, (i) => /* `chunks` progress events, then one result */)
      // Emit each event to the consumer while folding to the model-facing
      // output: the result event carries the bytes, progress events are counted.
      return events.pipe(
        Stream.runFoldEffect(
          () => ({ bytes: "", chunks: 0, completed: false }),
          (acc, event) =>
            emit(event).pipe(
              Effect.as(
                event.type === "result"
                  ? { ...acc, bytes: event.bytes, completed: true }
                  : { ...acc, chunks: acc.chunks + 1 },
              ),
            ),
        ),
        Effect.map(
          (acc): DownloadOutput =>
            acc.completed
              ? { status: "completed", bytes: acc.bytes, chunks: acc.chunks }
              : { status: "failed", bytes: "", chunks: acc.chunks },
        ),
      )
    },
    strict: true,
  })
```

## Recipe shape

Identical to basic-usage; the only difference is the toolkit:

```ts
onTurnComplete((turn) =>
  Effect.sync(() => {
    const calls = Turn.getToolCalls(turn)
    if (calls.length === 0) return stop()

    return Toolkit.run(toolkit, calls).pipe(
      Toolkit.continueWithResults(
        Toolkit.appendToolResults({ ...state, index: state.index + 1 }, turn),
      ),
    )
  }),
)
```

`Toolkit.appendToolResults(state, turn)` is shorthand for
`Turn.appendToHistory(state, turn, results.map(toToolCallOutput))`, with
`toToolCallOutput` imported from `@effect-uai/core/ToolResult`. Streaming
and plain tools dispatch uniformly inside `Toolkit.run`.

## What the consumer sees

For a single download with 3 chunks:

```
Progress { tool: "download_artifact", data: { type: "progress", pct: 33, ... } }
Progress { ...                         data: { type: "progress", pct: 67, ... } }
Progress { ...                         data: { type: "progress", pct: 100, ... } }
Progress { ...                         data: { type: "result",   bytes: "..." } }
Output   { result: ToolResult.Ok({ call_id, tool: "download_artifact", value: { status: "completed", ... } }) }
```

For the sub-agent: one `Progress` per inner `TextDelta` followed by
the final `Output` carrying the joined answer.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/streaming-tool-output/run.ts
```

The runner drives the download pattern (more visual demo). Tests in
`recipe.test.ts` cover both patterns offline using mocked inner streams.

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-tool-output/recipe.ts).
