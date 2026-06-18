---
name: effect-uai-streaming-tool-output
description: Use when a tool needs to emit progress, partial results, or sub-agent reasoning to the user UI in real time, while still returning one clean structured value to the model. Common cases — sub-agent text streaming, file download with progress, sandboxed exec output, long-running search.
license: MIT
---

# effect-uai streaming-tool-output

A tool's `run` is an `Effect` that computes the model-facing `Output`, plus an
`emit` side channel for intermediate events. Emitted events flow to the user as
`ToolEvent.Progress` in real time; the model only ever sees the `Output` that
`run` returns. There is no separate `finalize`: fold the events into the output
inside `run` as they stream by.

Reach for this when the user says any of:

- "Show progress while a tool runs"
- "Stream sub-agent reasoning to the UI but give the parent model the final answer"
- "I want a download / search tool with live progress and a clean structured result"

## Pattern 1: progress + terminal result

`emit` is `(event) => Effect<void>`, so it drops straight into
`Stream.runForEach`/`Stream.runFoldEffect`. Fold the events into the output in a
single pass (no buffering of the whole event log):

```ts
import { Duration, Effect, Schema, Stream } from "effect"
import * as Tool from "@effect-uai/core/Tool"

type DownloadEvent =
  | { readonly type: "progress"; readonly pct: number; readonly chunk: number }
  | { readonly type: "result"; readonly bytes: string }

export const makeDownloadTool = (perChunkDelay: Duration.Input = "150 millis") =>
  Tool.make({
    name: "download_artifact",
    description: "Download bytes from a URL.",
    inputSchema: Tool.fromEffectSchema(
      Schema.Struct({
        url: Schema.String,
        chunks: Schema.optional(Schema.Number),
      }),
    ),
    run: ({ url, chunks }, emit) => {
      const total = chunks ?? 4
      const events = Stream.unfold(0, (i: number): Effect.Effect<readonly [DownloadEvent, number] | undefined> => {
        if (i > total) return Effect.succeed(undefined)
        if (i === total)
          return Effect.succeed([{ type: "result", bytes: `bytes-of-${url}` }, i + 1] as const)
        return Effect.delay(
          Effect.succeed([
            { type: "progress", pct: Math.round(((i + 1) / total) * 100), chunk: i + 1 },
            i + 1,
          ] as const),
          perChunkDelay,
        )
      })
      // Emit each event to the consumer while folding to the model-facing output.
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
        Effect.map((acc) =>
          acc.completed
            ? { status: "completed" as const, bytes: acc.bytes, chunks: acc.chunks }
            : { status: "failed" as const, bytes: "", chunks: acc.chunks },
        ),
      )
    },
    strict: true,
  })
```

The user sees four `Progress` events (progress × 3 + result × 1) followed by one
`Output` carrying the structured result.

## Pattern 2: sub-agent (text streaming)

Consume the inner agent's stream, emitting each event while folding the text
deltas into the answer:

```ts
import * as Turn from "@effect-uai/core/Turn"

export const makeSubAgent = (
  runInner: (q: string) => Stream.Stream<Turn.TurnEvent, unknown, never>,
) =>
  Tool.make({
    name: "ask_subagent",
    description: "Ask a specialist sub-agent for help with a hard question.",
    inputSchema: Tool.fromEffectSchema(Schema.Struct({ question: Schema.String })),
    run: ({ question }, emit) =>
      runInner(question).pipe(
        Stream.runFoldEffect(
          () => "",
          (answer, event) =>
            emit(event).pipe(Effect.as(event._tag === "TextDelta" ? answer + event.text : answer)),
        ),
        Effect.map((answer) => ({ answer })),
      ),
    strict: true,
  })
```

`run` is parametrized over `runInner` so tests inject a mocked stream and
production passes a real inner-loop stream against the same provider.

A plain tool is the same shape that simply never calls `emit` (its `Event` type
is then irrelevant). Set `emitBufferSize` on the tool to bound its emit queue
(unbounded by default) when it emits faster than the consumer drains.

## How it slots into the loop

Identical to the basic-usage shape; only the toolkit differs. `Toolkit.run`
dispatches every tool uniformly:

```ts
const toolkit = Toolkit.make(downloadArtifact, subAgent)

onTurnComplete<State, ToolEvent>((turn) =>
  Effect.sync(() => {
    const calls = Turn.getToolCalls(turn)
    if (calls.length === 0) return stop()

    return Toolkit.run(toolkit, calls).pipe(
      Toolkit.continueWithResults(Toolkit.appendToolResults(state, turn)),
    )
  }),
)
```

## Consumer-side rendering

```ts
import { isProgress, isOutput } from "@effect-uai/core/ToolEvent"

Stream.runForEach(conversation, (event) =>
  "_tag" in event
    ? isProgress(event)
      ? Effect.logInfo("progress", event.data)
      : isOutput(event)
        ? Effect.logInfo("result", event.result)
        : Effect.void
    : Effect.void,
)
```

## See also

- Recipe source: `recipes/streaming-tool-output/index.ts`
- For approving sensitive calls: `effect-uai-tool-call-approval`
- For the basic non-streaming loop: `effect-uai-basic-usage`
