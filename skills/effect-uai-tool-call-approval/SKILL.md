---
name: effect-uai-tool-call-approval
description: Use when the user wants a human-in-the-loop verdict before sensitive tool calls run (send_email, delete_user, transfer_funds, etc.). Approvals can arrive synchronously bundled with the next HTTP request, or asynchronously over a long-lived queue / WebSocket. Every gated call ends up with a matching function_call_output in history regardless of verdict.
license: MIT
---

# effect-uai tool-call-approval

Some tool calls need a human verdict before they run. The model
proposes them; your application gates execution. The wire-protocol
invariant — every `function_call` must have a matching
`function_call_output` — is enforced via synthesized "denied" /
"cancelled" outputs.

Reach for this when the user says any of:

- "I want approval for sensitive tool calls"
- "Don't let the model `send_email` / `delete_user` without a human"
- "Show me human-in-the-loop tool gating"

## Two transport flavors

| Flavor               | When to use                                               | Planner                                         |
| -------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| HTTP (synchronous)   | Stateless request-shaped server; approvals arrive in body | `Approval.fromMap(predicate, approvals)(calls)` |
| Queue (asynchronous) | Long-lived WebSocket / SSE; verdicts arrive later         | `Approval.fromQueue(predicate, queue)(calls)`   |

Pick HTTP if your transport is request-shaped. Pick Queue if you've
got a persistent connection and want a streaming UI.

## HTTP variant (default)

```ts
import { Effect, Stream, pipe } from "effect"
import * as Approval from "@effect-uai/core/Approval"
import * as Items from "@effect-uai/core/Items"
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import { ToolEvent } from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

const SENSITIVE = new Set(["send_email", "delete_user"])
const isSensitive = (call: Items.ToolCall) => SENSITIVE.has(call.name)

export const httpConversation = (
  approvals: ReadonlyMap<string, Approval.ApprovalMapEntry>,
  state: { history: ReadonlyArray<Items.HistoryItem> },
) =>
  pipe(
    state,
    loop((current) =>
      Effect.gen(function* () {
        const oai = yield* Responses
        return oai.streamTurn({ history: current.history, model: "gpt-5.4-mini", tools }).pipe(
          onTurnComplete<typeof state, ToolEvent>((turn) =>
            Effect.sync(() => {
              const calls = Turn.getToolCalls(turn)
              if (calls.length === 0) return stop()

              const plan = Approval.fromMap(isSensitive, approvals)(calls)
              return Stream.merge(
                Toolkit.run(allTools, plan.approved),
                Stream.fromIterable(plan.rejected.map((result) => ToolEvent.Output({ result }))),
              ).pipe(Toolkit.continueWithResults(Toolkit.appendToolResults(current, turn)))
            }),
          ),
        )
      }),
    ),
  )
```

`approvals` is keyed by `call_id`. Entries are
`{ decision: "approve" }` or `{ decision: "deny", reason?: string }`.
Missing entries become `cancelled` outputs synthesized by
`Approval.fromMap`.

## Queue variant

```ts
import * as Approval from "@effect-uai/core/Approval"

const events = Stream.unwrap(
  Effect.gen(function* () {
    const { approved, decisions, approvalRequests } = yield* Approval.fromQueue(
      isSensitive,
      verdicts,
    )(calls)
    return Stream.merge(
      approvalRequests, // ApprovalRequested events drive the UI
      Stream.merge(
        Toolkit.run(allTools, approved),
        decisions.pipe(
          Stream.flatMap((d) =>
            d._tag === "Approved"
              ? Toolkit.run(allTools, [d.call])
              : Stream.succeed(ToolEvent.Output({ result: d.result })),
          ),
        ),
      ),
    )
  }),
)
```

The consumer side taps `ApprovalRequested` events, posts verdicts on
the same queue, and renders `Output` results as they arrive.

## What ends up in `state.history`

| Verdict / outcome    | `output` JSON                                    |
| -------------------- | ------------------------------------------------ |
| Approved + executed  | The tool's own structured return value.          |
| Denied               | `{ "kind": "denied", "reason": "..." }`          |
| Cancelled (HTTP)     | `{ "kind": "cancelled" }`                        |
| Tool execution error | `{ "kind": "execution_error", "reason": "..." }` |

History stays well-formed; the model reads the synthesized outputs on
the next turn and self-corrects.

## Reconciling history between requests

If a previous request left orphan `function_call`s (user navigated
away, server crashed, approvals timed out), reconcile before the next
request:

```ts
import { cancelAllPending } from "@effect-uai/core/HistoryCheck"
import { toToolCallOutput } from "@effect-uai/core/ToolResult"

const closures = cancelAllPending(stored, "user moved on")
const reconciledHistory = [
  ...stored,
  ...closures.map(toToolCallOutput),
  Items.userText(req.body.message),
]
```

## See also

- Recipe source: `recipes/tool-call-approval/index.ts`
- For tools that emit progress while running: `effect-uai-streaming-tool-output`
- Basic loop without approval: `effect-uai-basic-usage`
