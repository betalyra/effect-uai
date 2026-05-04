---
title: Tool call approval
description: Pause the loop on sensitive tool calls, wait for a human verdict, then approve, deny, or cancel each one before continuing.
---

**Scenario.** The model wants to call sensitive tools (`send_email`,
`delete_user`). Before they run, we ask the user. The reply is either
"approve" (run it), "deny" (don't run it; surface why), or nothing at all
(treat as cancelled). Whatever the verdict, every `function_call` ends up
with a matching `function_call_output` in history — the wire-protocol
invariant every modern provider enforces.

The HITL integration is explicit stream composition. Approval helpers split
calls into "run this" and "return this synthetic result"; the recipe then
chooses how to combine `Toolkit.executeAll` with those rejected outputs.
Nothing in the executor knows about approval policy.

## Two transport flavors

Same primitives, different approval planner:

- **HTTP (primary)** — approvals arrive synchronously bundled with the
  next request. `fromApprovalMap(predicate, approvals)(calls)` returns
  `{ approved, rejected }`; missing entries synthesize `cancelled`.
  Pure function. No queue, no router fiber. The simplest path.
- **Queue (enhancement)** — long-lived channel (WebSocket / SSE).
  `fromVerdictQueue(predicate, queue)(calls)` returns safe calls up
  front, emits `ApprovalRequested` events, and exposes a decision stream
  for gated calls as verdicts arrive.

Pick HTTP if your transport is request-shaped. Pick the queue variant if
you've got a persistent connection and want a streaming UI.

## HTTP variant (primary)

```ts
import { fromApprovalMap, type ApprovalMapEntry } from "@effect-uai/core/Resolvers"
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"
import * as Toolkit from "@effect-uai/core/Toolkit"

streamUntilComplete<State, ToolEvent>((turn) =>
  Effect.sync(() => {
    const next = Turn.cursor(state, turn)
    const calls = Turn.functionCalls(turn)
    if (calls.length === 0) return stop

    const plan = fromApprovalMap(isSensitive, approvals)(calls)
    const events = Stream.merge(
      Toolkit.executeAll(allTools, plan.approved),
      Toolkit.outputEvents(plan.rejected),
    )

    return Toolkit.nextStateFrom(events, (results) => ({
      ...next,
      history: [...next.history, ...results.map(toFunctionCallOutput)],
    }))
  }),
)
```

`approvals` is a `ReadonlyMap<string, ApprovalMapEntry>` keyed by
`call_id`. Entries are either `{ decision: "approve" }` or
`{ decision: "deny", reason?: string }`. A gated call without an entry
is placed in `plan.rejected` as a `cancelled` result. `Toolkit.outputEvents`
turns those results into `Output` events, and `nextStateFrom` keeps them
in history so the next provider request stays well-formed.

### Reconciling history before the next request

If the previous request left orphan `function_call`s (user navigated
away, server crashed, approvals timed out), the next request has to
synthesize closure outputs before submitting. That's an entry-point
concern, not the recipe's:

```ts
import {
  cancelAllPending,
  findUnansweredCalls,
} from "@effect-uai/core/HistoryCheck"
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"

// In your HTTP route handler, before invoking httpConversation:
const stored = await store.load(req.sessionId)
const closures = cancelAllPending(stored, "user moved on")
const reconciledHistory = [
  ...stored,
  ...closures.map(toFunctionCallOutput),
  Items.userText(req.body.message),
]
return httpConversation(req.body.approvals, { history: reconciledHistory })
```

Use whenever a checkpoint, timeout, or new user message could leave
`function_call`s without matching outputs.

## Queue variant (enhancement)

For long-lived connections where verdicts arrive over time. Safe calls
start immediately. Gated calls emit `ApprovalRequested`, then each one
waits until its specific verdict lands on the queue.

```ts
import { fromVerdictQueue } from "@effect-uai/core/Resolvers"

streamUntilComplete<State, ToolEvent>((turn) =>
  Effect.sync(() => {
    const next = Turn.cursor(state, turn)
    const calls = Turn.functionCalls(turn)
    if (calls.length === 0) return stop

    // `Stream.unwrap` supplies the Scope that fromVerdictQueue's router
    // fiber lives in. Router stays alive as long as the consumer pulls
    // events.
    const events = Stream.unwrap(
      Effect.gen(function* () {
        const { approved, decisions, announce } = yield* fromVerdictQueue(
          isSensitive,
          verdicts,
        )(calls)
        return Stream.merge(
          announce,
          Stream.merge(
            Toolkit.executeAll(allTools, approved),
            decisions.pipe(
              Stream.flatMap((decision) =>
                decision._tag === "Approved"
                  ? Toolkit.executeAll(allTools, [decision.call])
                  : Stream.succeed(Toolkit.outputEvent(decision.result)),
              ),
            ),
          ),
        )
      }),
    )

    return Toolkit.nextStateFrom(events, (results) => ({
      ...next,
      history: [...next.history, ...results.map(toFunctionCallOutput)],
    }))
  }),
)
```

The consumer side typically taps `ApprovalRequested` events, posts
verdicts onto the same queue, and renders `Output` results as they arrive.

## What you get in `state.history`

Whatever the path — Value, denied, cancelled — every gated call ends up
with a `FunctionCallOutput` carrying a structured payload:

| Verdict / outcome    | `output` JSON                                  |
| -------------------- | ---------------------------------------------- |
| Approved + executed  | The tool's own structured return value.        |
| Denied               | `{ "kind": "denied", "reason": "..." }`        |
| Cancelled (HTTP)     | `{ "kind": "cancelled" }`                      |
| Tool execution error | `{ "kind": "execution_error", "reason": "..."}`|

History stays well-formed; the model reads the synthesized outputs on
the next turn and self-corrects if needed.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/tool-call-approval/run.ts
```

The runner drives the queue variant since it's the more visual demo
(simulated user posting verdicts after a delay). The HTTP variant is
better exercised by tests or in a real HTTP handler.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/tool-call-approval/index.ts).
