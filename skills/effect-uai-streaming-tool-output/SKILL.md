---
name: effect-uai-streaming-tool-output
description: Use when a tool needs to emit progress, partial results, or sub-agent reasoning to the user UI in real time, while still returning one clean structured value to the model. Common cases — sub-agent text streaming, file download with progress, sandboxed exec output, long-running search.
license: MIT
---

# effect-uai streaming-tool-output

`Tool.streaming` lets a tool emit a `Stream<Event>` from its `run`,
plus a `finalize` that reduces the events into the model-facing
output. Inner events flow to the user as `ToolEvent.Intermediate`s in
real time; the model only ever sees `finalize(events)`.

Reach for this when the user says any of:

- "Show progress while a tool runs"
- "Stream sub-agent reasoning to the UI but give the parent model the final answer"
- "I want a download / search tool with live progress and a clean structured result"

## Pattern 1: progress + terminal result

```ts
import { Duration, Effect, Schema, Stream } from "effect"
import * as Tool from "@effect-uai/core/Tool"

type DownloadEvent =
  | { readonly type: "progress"; readonly pct: number; readonly chunk: number }
  | { readonly type: "result"; readonly bytes: string }

export const makeDownloadTool = (perChunkDelay: Duration.Input = "150 millis") =>
  Tool.streaming({
    name: "download_artifact",
    description: "Download bytes from a URL.",
    inputSchema: Tool.fromEffectSchema(
      Schema.Struct({
        url: Schema.String,
        chunks: Schema.optional(Schema.Number),
      }),
    ),
    run: ({ url, chunks }) => {
      const total = chunks ?? 4
      return Stream.unfold(0, (i: number) => {
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
    },
    finalize: (events) => {
      const result = events.find(
        (e): e is Extract<DownloadEvent, { type: "result" }> => e.type === "result",
      )
      const chunks = events.filter((e) => e.type === "progress").length
      return result
        ? { status: "completed" as const, bytes: result.bytes, chunks }
        : { status: "failed" as const, bytes: "", chunks }
    },
    strict: true,
  })
```

The user sees four `Intermediate` events (progress × 3 + result × 1)
followed by one `Output` carrying the structured `DownloadOutput`.

## Pattern 2: sub-agent (text streaming)

```ts
import * as Turn from "@effect-uai/core/Turn"

export const makeSubAgent = (
  runInner: (q: string) => Stream.Stream<Turn.TurnEvent, unknown, never>,
) =>
  Tool.streaming({
    name: "ask_subagent",
    description: "Ask a specialist sub-agent for help with a hard question.",
    inputSchema: Tool.fromEffectSchema(Schema.Struct({ question: Schema.String })),
    run: ({ question }) => runInner(question),
    finalize: (events) => ({
      answer: events
        .filter(
          (e): e is Extract<Turn.TurnEvent, { type: "text_delta" }> => e.type === "text_delta",
        )
        .map((e) => e.text)
        .join(""),
    }),
    strict: true,
  })
```

`run` is parametrized over `runInner` so tests inject a mocked stream
and production passes a real inner-loop stream against the same
provider.

## How it slots into the loop

Identical to the basic-usage shape; only the toolkit differs.
`Toolkit.executeAll` dispatches streaming and plain tools uniformly:

```ts
streamUntilComplete<State, ToolEvent>((turn) =>
  Effect.sync(() => {
    const calls = Turn.functionCalls(turn)
    if (calls.length === 0) return stop

    const events = Toolkit.executeAll(allTools, calls)
    return Toolkit.nextStateFrom(events, (results) =>
      Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
    )
  }),
)
```

## Consumer-side rendering

```ts
import { isIntermediate, isOutput } from "@effect-uai/core/ToolEvent"

Stream.runForEach(conversation, (event) =>
  "_tag" in event
    ? isIntermediate(event)
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
