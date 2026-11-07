---
title: Streaming tool output
description: "Two flavors of a tool whose `run` returns a Stream: sub-agent text streaming and progress snapshots."
source: recipes/streaming-tool-output
icon: PiPulse
---

Streaming tools let the user see inner work without leaking the whole event
log back to the model.

The tool's `run` returns a `Stream` of snapshots of its own output type. Every
element but the last reaches the consumer as a `ToolEvent.Partial`; the last is
the result the model sees. Because a partial has the tool's output type, a UI
decodes and renders it with the same schema as the result. Rich UI for the
user, clean data for the model.

This recipe shows two patterns side-by-side:

| Pattern   | Inner stream             | What each snapshot holds               |
| --------- | ------------------------ | -------------------------------------- |
| Sub-agent | `Stream<Turn.TurnEvent>` | The answer so far                      |
| Progress  | one element per chunk    | `status`, `pct` and, at the end, bytes |

A third pattern (each event IS a result item: recipe streamer, search
hits, transcoded chunks) follows the same shape; just have `run` scan
events into a growing list.

## Pattern 1: sub-agent

The outer model calls `ask_subagent`; an inner agent runs (its own
conversation). `run` scans its text deltas into the answer so far, so the
user sees the sub-agent's answer grow as `ToolEvent.Partial`s while the
outer model receives only the final, full answer.

```ts
export const makeSubAgent = (
  runInner: (question: string) => Stream.Stream<Turn.TurnEvent, unknown, never>,
) =>
  Tool.make({
    name: "ask_subagent",
    description: "Ask a specialist sub-agent for help with a hard question.",
    inputSchema: SubAgentInput,
    outputSchema: SubAgentOutput,
    // The answer so far, one snapshot per text delta; the last is the full answer.
    run: ({ question }) =>
      runInner(question).pipe(
        Turn.textDeltas,
        Stream.scan(
          () => "",
          (answer, text: string) => answer + text,
        ),
        Stream.map((answer): SubAgentOutput => ({ answer })),
      ),
    strict: true,
  })
```

`run` is parametrized over `runInner` so tests inject a mocked stream
and production passes a real inner-loop stream. The model gets a clean
string, not the raw event log.

## Pattern 2: progress snapshots

The model calls `download_artifact` (or sandboxed exec, web search,
transcoding, ...). Progress is part of the output type: the tool emits one
`running` snapshot per chunk, then one `completed` snapshot with the bytes.
Partials drive a UI progress bar; the model receives the completed value.

```ts
export const DownloadOutput = Schema.Struct({
  status: Schema.Literals(["running", "completed"]),
  pct: Schema.Number,
  chunks: Schema.Number,
  bytes: Schema.String,
})

export const makeDownloadTool = (perChunkDelay: Duration.Input = "150 millis") =>
  Tool.make({
    name: "download_artifact",
    description: "Download bytes from a URL...",
    inputSchema: DownloadInput,
    outputSchema: DownloadOutput,
    run: ({ url, chunks }) => {
      const total = chunks ?? 4
      const running = Stream.range(1, total).pipe(
        Stream.mapEffect((chunk) =>
          Effect.delay(
            Effect.succeed<DownloadOutput>({
              status: "running",
              pct: Math.round((chunk / total) * 100),
              chunks: chunk,
              bytes: "",
            }),
            perChunkDelay,
          ),
        ),
      )
      const completed = Stream.succeed<DownloadOutput>({
        status: "completed",
        pct: 100,
        chunks: total,
        bytes: `bytes-of-${url}`,
      })
      return Stream.concat(running, completed)
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
      Toolkit.next(toolkit, { ...state, index: state.index + 1 }, turn),
    )
  }),
)
```

`Toolkit.next` forwards every event, encodes each outcome with the tool's
`outputSchema`, and appends the turn plus the outputs to history. Streaming
and plain tools dispatch uniformly inside `Toolkit.run`.

## What the consumer sees

For a single download with 3 chunks:

```
Partial { tool: "download_artifact", value: { status: "running", pct: 33, chunks: 1, bytes: "" } }
Partial { ...                        value: { status: "running", pct: 67, chunks: 2, bytes: "" } }
Partial { ...                        value: { status: "running", pct: 100, chunks: 3, bytes: "" } }
Output  { call_id, tool: "download_artifact", result: Success({ status: "completed", pct: 100, ... }) }
```

`e.tool === "download_artifact"` narrows `value` and `result` to
`DownloadOutput`. For the sub-agent: one `Partial` per inner `TextDelta`
carrying the answer so far, followed by the `Output` with the full answer.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/streaming-tool-output/run.ts
```

The runner drives the download pattern (more visual demo). Tests in
`recipe.test.ts` cover both patterns offline using mocked inner streams.

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-tool-output/recipe.ts).
