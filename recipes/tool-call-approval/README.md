---
title: Tool call approval
description: Pause the loop on sensitive tool calls, wait for a human verdict, then approve, deny, or cancel each one before continuing.
source: recipes/tool-call-approval
icon: PiShieldCheck
---

**Scenario.** The model wants to call sensitive tools (`send_email`,
`delete_user`). Before they run, we ask the user. The reply is either
"approve" (run it), "deny" (don't run it; surface why), or nothing at all
(treat as cancelled). Whatever the verdict, every `function_call` ends up
with a matching `function_call_output` in history, the wire-protocol
invariant every modern provider enforces.

The HITL integration is explicit stream composition. Approval helpers split
calls into "run this" and "return this synthetic result"; the recipe then
chooses how to combine `Toolkit.run` with those rejected outputs.
Nothing in the executor knows about approval policy.

## Two transport flavors

Same primitives, different approval planner:

- **HTTP (primary)**: approvals arrive synchronously bundled with the
  next request. `Approval.fromMap(predicate, approvals)(calls)` returns
  `{ approved, rejected }`; missing entries synthesize `cancelled`.
  Pure function. No queue, no router fiber. The simplest path.
- **Queue (enhancement)**: long-lived channel (WebSocket / SSE).
  `Approval.fromQueue(predicate, queue)(calls)` returns safe calls up
  front, emits `ApprovalRequested` events, and exposes a decision stream
  for gated calls as verdicts arrive.

Pick HTTP if your transport is request-shaped. Pick the queue variant if
you've got a persistent connection and want a streaming UI.

## HTTP variant (primary)

```ts
import * as Approval from "@effect-uai/core/Approval"
import { type ApprovalMapEntry } from "@effect-uai/core/Approval"
import * as Toolkit from "@effect-uai/core/Toolkit"

onTurnComplete((turn) =>
  Effect.sync(() => {
    const calls = Turn.getToolCalls(turn)
    // No requested tools means there is nothing to approve or execute.
    if (calls.length === 0) return stop()

    const plan = Approval.fromMap(isSensitive, approvals)(calls)
    return Stream.merge(
      // Approved calls run; denied/missing approvals still become outputs.
      Toolkit.run(toolkit, plan.approved),
      Stream.fromIterable(plan.rejected.map((result) => ToolEvent.Output({ result }))),
    ).pipe(Toolkit.continueWithResults(Toolkit.appendToolResults(current, turn)))
  }),
)
```

`approvals` is a `ReadonlyMap<string, ApprovalMapEntry>` keyed by
`call_id`. Entries are either `{ decision: "approve" }` or
`{ decision: "deny", reason?: string }`. A gated call without an entry
is placed in `plan.rejected` as a `cancelled` result. The
`Stream.fromIterable(...ToolEvent.Output(...))` line turns those
results into `Output` events, and `continueWithResults` keeps them in
history so the next provider request stays well-formed.
`Toolkit.appendToolResults(current, turn)` collapses the collect, the
`toToolCallOutput` conversion, and the `Turn.appendToHistory` append into
one step.

### Reconciling history before the next request

If the previous request left orphan `function_call`s (user navigated
away, server crashed, approvals timed out), the next request has to
synthesize closure outputs before submitting. That's an entry-point
concern, not the recipe's:

```ts
import { cancelAllPending, findUnansweredCalls } from "@effect-uai/core/HistoryCheck"
import { toToolCallOutput } from "@effect-uai/core/ToolResult"

// In your HTTP route handler, before invoking httpConversation:
const stored = await store.load(req.sessionId)
const closures = cancelAllPending(stored, "user moved on")
const reconciledHistory = [
  ...stored,
  ...closures.map(toToolCallOutput),
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
import * as Approval from "@effect-uai/core/Approval"

// Approved decisions run; denied/cancelled decisions become synthetic outputs.
const decisionEvents = (decision: Approval.ApprovalDecision): Stream.Stream<ToolEvent> =>
  decision._tag === "Approved"
    ? Toolkit.run(toolkit, [decision.call])
    : Stream.succeed(ToolEvent.Output({ result: decision.result }))

onTurnComplete((turn) =>
  Effect.sync(() => {
    const calls = Turn.getToolCalls(turn)
    // No requested tools means there is nothing to approve or execute.
    if (calls.length === 0) return stop()

    // `Stream.unwrap` supplies the Scope that fromQueue's router
    // fiber lives in. Router stays alive as long as the consumer pulls
    // events.
    const events = Stream.unwrap(
      Effect.gen(function* () {
        const { approved, decisions, approvalRequests } = yield* Approval.fromQueue(
          isSensitive,
          verdicts,
        )(calls)
        return Stream.merge(
          approvalRequests,
          Stream.merge(
            // Safe calls start immediately; gated calls resume as verdicts arrive.
            Toolkit.run(toolkit, approved),
            decisions.pipe(Stream.flatMap(decisionEvents)),
          ),
        )
      }),
    )

    return events.pipe(Toolkit.continueWithResults(Toolkit.appendToolResults(current, turn)))
  }),
)
```

The consumer side typically taps `ApprovalRequested` events, posts
verdicts onto the same queue, and renders `Output` results as they arrive.

## What you get in `state.history`

Whatever the path (approved, denied, cancelled), every gated call ends up
with a `function_call_output` carrying a structured payload:

| Verdict / outcome    | `output` JSON                                   |
| -------------------- | ----------------------------------------------- |
| Approved + executed  | The tool's own structured return value.         |
| Denied               | `{ "kind": "denied", "reason": "..." }`         |
| Cancelled (HTTP)     | `{ "kind": "cancelled" }`                       |
| Tool execution error | `{ "kind": "execution_error", "reason": "..."}` |

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
