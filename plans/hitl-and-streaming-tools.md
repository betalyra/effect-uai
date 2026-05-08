# Plan — HITL and Streaming Tools

This plan records the shipped shape for human-in-the-loop tool approval and
streaming tools.

The current design keeps tool execution deliberately small:

- `Toolkit.executeAll(tools, calls)` only executes calls.
- Approval helpers produce plain data: calls to run and synthetic results to
  return.
- Recipes explicitly compose `executeAll`, `Toolkit.outputEvents`, and
  `Toolkit.nextStateFrom`.

That keeps approval policy visible at the recipe boundary instead of hiding it
inside the executor.

## Context

We need two related capabilities:

1. **Streaming tools** — tools whose `run` is a `Stream<Event>` rather than an
   `Effect<Output>`. Each event flows through to the consumer in real time; a
   `finalize(events)` function reduces the collected events to the model-facing
   output.
2. **Human-in-the-loop tool calls** — gate sensitive calls (`send_email`,
   `delete_database`, `bulk_email`) on a user verdict before executing. Works
   over request-shaped HTTP and over long-lived channels such as WebSocket/SSE.

Both share the same provider invariant: every `function_call` in history needs
a matching `function_call_output` before the next provider request. Denied,
cancelled, unknown, and failed tool calls therefore still produce structured
`ToolResult.Failure` values that recipes convert with `toFunctionCallOutput`.

## Shipped Building Blocks

### Tool Kinds

```ts
Tool.make({
  name,
  description,
  inputSchema,
  run,
  strict,
})

Tool.streaming({
  name,
  description,
  inputSchema,
  run,
  finalize,
  strict,
})
```

Both plain and streaming tools can be passed to `Toolkit.executeAll`.

### Results And Events

```ts
type ToolResult =
  | { _tag: "Value"; call_id: string; tool: string; value: unknown }
  | { _tag: "Failure"; call_id: string; tool: string; kind: string; reason?: string }

type ToolEvent =
  | { _tag: "ApprovalRequested"; call_id: string; tool: string; arguments: string }
  | { _tag: "Intermediate"; call_id: string; tool: string; data: unknown }
  | { _tag: "Output"; result: ToolResult }
```

`ToolResult` stays structured until the recipe appends results to history:

```ts
return Toolkit.nextStateFrom(events, (results) => ({
  ...next,
  history: [...next.history, ...results.map(toFunctionCallOutput)],
}))
```

### Execution

```ts
const events = Toolkit.executeAll(allTools, calls)
```

`executeAll` does not know about approval policy. It parses arguments, validates
input, dispatches plain and streaming tools, emits streaming intermediates, and
produces one `Output` per call it was asked to run.

Synthetic results are converted to events explicitly:

```ts
const rejected = Toolkit.outputEvents(plan.rejected)
```

### Approval Planning

HTTP/request-shaped flow:

```ts
const plan = fromApprovalMap(isSensitive, approvals)(calls)
const events = Stream.merge(
  Toolkit.executeAll(allTools, plan.approved),
  Toolkit.outputEvents(plan.rejected),
)
```

Long-lived queue flow:

```ts
const { approved, decisions, announce } = yield * fromVerdictQueue(isSensitive, verdicts)(calls)

const events = Stream.merge(
  announce,
  Stream.merge(
    Toolkit.executeAll(allTools, approved),
    decisions.pipe(Stream.flatMap(decisionToEvents)),
  ),
)
```

The queue helper returns safe calls immediately, emits `ApprovalRequested`
events for gated calls, and then yields one later decision per gated call.

### History Reconciliation

```ts
findUnansweredCalls(history): ReadonlyArray<FunctionCall>
isReconciled(history): boolean
cancelAllPending(history, reason?): ReadonlyArray<ToolResult>
```

Recipe authors call these at known transition points: a new request arrived, a
checkpoint loaded, a timer fired, or a user redirected the conversation.

## Current Follow-Ups

- Consider whether the `Resolvers` module should be renamed to an
  approval-oriented module name in a later breaking pass.
- Keep approval combinators as recipe-level examples until there is repeated
  demand for a shared abstraction.
- Keep retry, timeout, and permission policy outside `executeAll`; those are
  application choices around `tool.run` or approval planning.
