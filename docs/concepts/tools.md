---
title: Tools and toolkits
description: Plain and streaming tools, explicit execution, structured results, approval gating, and history reconciliation.
---

A tool is a typed function the model can request. The framework owns
three jobs: render the tool's schema to the provider's wire format,
validate incoming arguments and run the tool, and translate the
outcome (success, denied, cancelled, error) into something the model
can read on the next turn. You own the `run` function and the policy
around it.

Two flavors:

- **Plain tools** — `run` returns an `Effect<Output>`. One value, one
  shot. The vast majority of tools.
- **Streaming tools** — `run` returns a `Stream<Event>`. Each event
  flows through to the consumer in real time; `finalize(events)`
  reduces the collected events into the model-facing `Output`. For
  sub-agents, progress reporting, and any tool whose internal
  reasoning the user should see live.

Both kinds dispatch through the same executor.

## `Tool.make` — plain tools

```ts
import { Effect, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"

const GetCurrentTimeInput = Schema.Struct({
  timezone: Schema.String,
})

const getCurrentTime = Tool.make({
  name: "get_current_time",
  description: "Look up the current local time for an IANA timezone.",
  inputSchema: Tool.fromEffectSchema(GetCurrentTimeInput),
  run: ({ timezone }) => Effect.succeed({ timezone, iso: new Date().toISOString() }),
  strict: true,
})
```

A plain `Tool` is `{ name, description, inputSchema, run, strict? }`.
`run` returns an `Effect`; its requirements flow out via the executor.

`strict` (default `true`) controls whether the provider renders the
tool with its strict-mode flag (OpenAI's `strict: true`, Gemini's
equivalent). The framework never rewrites your schema; if the rendered
JSON Schema is incompatible with strict mode, the provider returns an
error and you either drop `strict` or simplify the schema.

## `Tool.streaming` — streaming tools

```ts
import { Stream } from "effect"

const askSubagent = Tool.streaming({
  name: "ask_subagent",
  description: "Ask a specialist sub-agent for help.",
  inputSchema: Tool.fromEffectSchema(SubAgentInput),
  run: ({ question }) => runInner(question),  // Stream<TurnEvent>
  finalize: (events): SubAgentOutput => ({
    answer: events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.text)
      .join(""),
  }),
  strict: true,
})
```

A `StreamingTool` is `{ name, description, inputSchema, run, finalize, strict? }`.
`run` returns `Stream<Event, unknown, R>`; events flow through to the
consumer real-time as `ToolEvent.Intermediate`s. When the stream ends,
`finalize(events)` reduces the collected events into the structured
`Output` the model sees in the next turn.

Three canonical `finalize` patterns: text concat (sub-agents), result
list (recipe streamers, search hits), progress + terminal result
(downloads, sandboxed exec). See the [Streaming tool output recipe](/recipes/streaming-tool-output/)
for all three side-by-side.

## `inputSchema` — any Standard Schema

`inputSchema` is `StandardSchemaV1 & StandardJSONSchemaV1`: any library
that implements both interfaces works directly. That includes Zod 4+,
Valibot, and ArkType. Effect Schema needs `Tool.fromEffectSchema` to
attach the two extensions.

The same schema is used for two things:

- **Wire rendering**: `Tool.toDescriptors` calls
  `inputSchema.~standard.jsonSchema.input({ target: "draft-2020-12" })`
  to produce the JSON Schema each provider sends.
- **Argument validation**: when the model returns a `FunctionCall`,
  the executor parses the arguments string, runs the schema's
  `validate`, and either passes the parsed value to `run` or
  synthesizes a `Failure(execution_error)` result.

## Wiring tools up

For homogeneous plain-tool toolkits, use `Toolkit.make`:

```ts
import * as Toolkit from "@effect-uai/core/Toolkit"

const toolkit = Toolkit.make([getCurrentTime, lookupWeather])
const tools = Toolkit.toDescriptors(toolkit)
```

For mixed plain + streaming tools, use a flat array typed
`ReadonlyArray<Tool.AnyKindTool>` and `Tool.toDescriptors`:

```ts
const allTools: ReadonlyArray<Tool.AnyKindTool> = [
  getCurrentTime,   // plain
  askSubagent,      // streaming
]
const tools = Tool.toDescriptors(allTools)
```

Both forms produce the provider-agnostic `ToolDescriptor[]` the
generic `LanguageModel` accepts. Providers map `inputSchema` to their
own wire field (`parameters` for OpenAI, `input_schema` for Anthropic).

## `Toolkit.executeAll` — the executor

```ts
import * as Toolkit from "@effect-uai/core/Toolkit"

const events = Toolkit.executeAll(allTools, calls)
//   ^? Stream<ToolEvent>
```

`executeAll` runs every requested tool concurrently and emits a
`Stream<ToolEvent>` in real time. Three event variants:

- **`Intermediate`** — one per element from a streaming tool's `run`
  stream. Plain tools don't emit any.
- **`Output`** — one per call, terminal. Carries a structured
  `ToolResult` (see below).
- **`ApprovalRequested`** — emitted by the `fromVerdictQueue` approval planner
  for gated calls (see "Approval gating").

The executor is graceful by default. A single hallucinated tool name
produces a `Failure(unknown_tool)` for that call only; other calls in
the turn execute normally. Tool runtime errors and schema validation
failures become `Failure(execution_error)` results — never thrown.
Defects from tool code itself flow through the stream's failure
channel.

Concurrency defaults to `"unbounded"`; pass `{ concurrency: 4 }` to
bound it.

## `ToolResult` — structured results

The executor speaks in `ToolResult` (structured), not `FunctionCallOutput`
(wire-shaped). This lets recipes inspect, redact, audit, or re-route
tool values *before* serialization without parse-and-restringify.

```ts
type ToolResult =
  | { _tag: "Value";   call_id: string; tool: string; value: unknown }
  | { _tag: "Failure"; call_id: string; tool: string; kind: string; reason?: string }
```

Synthesizers from `@effect-uai/core/Outcome`:

```ts
import { denied, cancelled, rejected, executionError } from "@effect-uai/core/Outcome"

denied(call, reason?)            // { kind: "denied", reason? }
cancelled(call, reason?)         // { kind: "cancelled", reason? }
rejected(call, "permission_denied", "...")  // any custom kind
executionError(call, "...")      // { kind: "execution_error", reason }
```

The executor doesn't inspect `kind`. It's recipe-level metadata for
audit logs, analytics, and downstream pattern-matching. Two canonical
kinds (`denied`, `cancelled`); anything else is a `rejected(call, kind, reason)`
with a recipe-chosen string.

## Wire conversion at the boundary

`Stream<ToolEvent>` carries structured values; `state.history` carries
wire-shaped `FunctionCallOutput`s. The single explicit conversion
point: `toFunctionCallOutput`, applied where results meet history.

```ts
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"

return Toolkit.nextStateFrom(events, (results) => ({
  ...next,
  history: [...next.history, ...results.map(toFunctionCallOutput)],
}))
```

`nextStateFrom` collects `ToolResult`s from the executor stream and
hands them to the builder; the recipe applies `toFunctionCallOutput`
to wire-encode each one before appending to history.

## The round-trip shape

The full pattern is in [Basic usage](/recipes/basic-usage/). The body:

```ts
streamUntilComplete<State, ToolEvent>((turn) =>
  Effect.sync(() => {
    const next = Turn.cursor(state, turn)
    const calls = Turn.functionCalls(turn)
    if (calls.length === 0) return stop

    const events = Toolkit.executeAll(allTools, calls)
    return Toolkit.nextStateFrom(events, (results) => ({
      ...next,
      history: [...next.history, ...results.map(toFunctionCallOutput)],
    }))
  }),
)
```

`Turn.cursor` extends history with the turn's items (including the
`FunctionCall`s themselves), then `nextStateFrom` appends the
`FunctionCallOutput`s. Both must be present for the model to see what
it asked for *and* what came back.

## Approval gating

For HITL flows, keep `executeAll` as the only executor. Approval helpers
return plain data that the recipe composes explicitly:

```ts
type ToolCallPlan = {
  readonly approved: ReadonlyArray<FunctionCall>
  readonly rejected: ReadonlyArray<ToolResult>
}
```

HTTP/request-shaped flows:

```ts
const plan = fromApprovalMap(isSensitive, approvals)(calls)
const events = Stream.merge(
  Toolkit.executeAll(allTools, plan.approved),
  Toolkit.outputEvents(plan.rejected),
)
```

`fromApprovalMap(predicate, approvals)(calls)` looks up gated calls by
`call_id`. Approved calls go into `plan.approved`; denied or missing
entries become synthetic `ToolResult`s in `plan.rejected`. Those rejected
results are still emitted as `Output` events, so every model-requested
tool call receives a matching tool result in history.

Long-lived queue flows:

```ts
const { approved, decisions, announce } =
  yield* fromVerdictQueue(isSensitive, verdicts)(calls)

const events = Stream.merge(
  announce,
  Stream.merge(
    Toolkit.executeAll(allTools, approved),
    decisions.pipe(Stream.flatMap(decisionToEvents)),
  ),
)
```

`fromVerdictQueue(predicate, verdicts)(calls)` returns safe calls up
front, an `announce` stream of `ApprovalRequested` events, and a decision
stream for gated calls as verdicts arrive. The recipe decides how to turn
approved decisions into `executeAll` calls and rejected decisions into
`Output` events.

Full walkthrough in the [Tool call approval recipe](/recipes/tool-call-approval/).

## History reconciliation

Every provider rejects a new request if any prior `function_call`
lacks a matching `function_call_output`. Multi-turn flows that can be
interrupted, restarted, or branched (HITL, mid-stream abort,
checkpoints, stateless HTTP servers) need to detect orphans and
synthesize closure outputs before submitting:

```ts
import {
  cancelAllPending,
  findUnansweredCalls,
  isReconciled,
} from "@effect-uai/core/HistoryCheck"

const closures = cancelAllPending(history, "user moved on")
const reconciled = [...history, ...closures.map(toFunctionCallOutput)]
```

Use whenever a checkpoint, timeout, or new user message could leave
function calls without matching outputs. Recipe author calls these at
known transition points; not invoked from inside the loop.

## What's not built in

- **No retry policies.** Wrap `tool.run` with `Effect.retry` if you
  want them.
- **No timeout per tool.** Compose with `Effect.timeout`.
- **No magic history reconciliation.** `cancelAllPending` is explicit;
  the recipe decides when to call it.

These are policy decisions, and the primitives give you the seam to
plug them in without forking the framework.
