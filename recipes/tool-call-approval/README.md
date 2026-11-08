---
title: Tool call approval
description: Pause the loop on sensitive tool calls, wait for a human answer, then approve, deny, or cancel each one before continuing.
source: recipes/tool-call-approval
icon: PiShieldCheck
---

**Scenario.** The model wants to call sensitive tools (`send_email`,
`delete_user`). Before they run, we ask the user. The answer is either
"approve" (run it), "deny" (don't run it; surface why), or nothing at all
(treat as cancelled). Whatever the answer, every `function_call` ends up
with a matching `function_call_output` in history, the wire-protocol
invariant every modern provider enforces.

The HITL integration is explicit stream composition. `Approval` groups the
waiting calls by answer; the recipe then runs the approved ones with
`Toolkit.run` and closes the rest with typed errors. Nothing in the executor
knows about approval policy.

## Two transport flavors

Same primitives, different approval planner:

- **HTTP (primary)**: answers arrive synchronously bundled with the
  next request. `Approval.Default.resolve(waiting, answers)` returns
  `{ Approve, Deny, unanswered }`; unanswered calls are closed as
  cancelled. Pure function. No queue, no router fiber. The simplest path.
- **Queue (enhancement)**: long-lived channel (WebSocket / SSE).
  `fromQueue(predicate, answers, { timeout? })(calls)`, defined in this
  recipe, runs safe calls up front, announces each gated call with the
  recipe's own `ApprovalRequested` event, and runs or closes it once its
  answer (or the timeout) arrives. It is app code: copy it and change the
  wait (a database, a Slack button, a timeout policy).

Pick HTTP if your transport is request-shaped. Pick the queue variant if
you've got a persistent connection and want a streaming UI.

## Answers and closings

An answer is an `Approval.Default` decision for one call: approve, or deny
with an optional reason.

```ts
import * as Approval from "@effect-uai/core/Approval"
import * as ToolOutput from "@effect-uai/core/ToolOutput"

export type Decision = typeof Approval.Default.schema.Type
export type Answer = Approval.Answer<Decision>
// { callId, decision: Approval.Default.Approve() | Approval.Default.Deny({ reason? }) }
```

A sensitive tool declares `Approval.Denied` in its `failureSchema`: its `run`
never raises it, but the app may close a call with it. Core's
`ToolOutput.Cancelled` is possible for every tool.

```ts
const deleteUser = Tool.make({
  name: "delete_user",
  description: "Permanently delete a user account.",
  inputSchema: Schema.Struct({ user_id: Schema.String }),
  failureSchema: Approval.Denied,
  run: ({ user_id }) => Effect.succeed({ status: "deleted", user_id }),
})

// The model sees a closed call like any failed one.
export const close = (call: Items.ToolCall, error: Approval.Denied | ToolOutput.Cancelled) =>
  Toolkit.close(toolkit, call, error)
```

A denied or cancelled call becomes an `Output` event whose `result` is a
`Result.fail`. Because the error is declared by the call's tool, `Toolkit.next`
encodes it into history like any other outcome. `close` checks that when it
runs: a `Denied` on `search_emails` fails with `UndeclaredFailure`. A tool from somewhere else
(MCP, a library) gets the same with `Tool.withFailures(tool, Approval.Denied)`.

## HTTP variant (primary)

```ts
onTurnComplete((turn) =>
  Effect.gen(function* () {
    const calls = Turn.getToolCalls(turn)
    // No requested tools means there is nothing to approve or execute.
    if (calls.length === 0) return stop()

    const { Approve, Deny, unanswered } = Approval.Default.resolve(
      calls.filter(isSensitive),
      answers,
    )
    const closed = yield* Effect.all([
      ...Deny.map(({ call, decision }) => close(call, denied(decision.reason))),
      ...unanswered.map((call) =>
        close(call, new ToolOutput.Cancelled({ message: "No approval was given." })),
      ),
    ])
    const run = [...calls.filter((c) => !isSensitive(c)), ...Approve.map((a) => a.call)]
    return Stream.merge(Toolkit.run(toolkit, run), Stream.fromIterable(closed)).pipe(
      Toolkit.next(toolkit, current, turn),
    )
  }),
)
```

`answers` is a `ReadonlyArray<Answer>`, matched to calls by `callId`. A gated call
without an answer lands in `unanswered` and is closed as `Cancelled`.
`close(call, error)` builds the `Output` event for a closed call, and
`Toolkit.next(toolkit, current, turn)` forwards every event, then appends the
turn plus one output per call so the next provider request stays well-formed.

### Reconciling history before the next request

If the previous request left orphan `function_call`s (user navigated
away, server crashed, approvals timed out), the next request has to
synthesize closure outputs before submitting. That's an entry-point
concern, not the recipe's:

```ts
import * as HistoryCheck from "@effect-uai/core/HistoryCheck"

// In your HTTP route handler, before invoking httpConversation:
const answers = yield * Schema.decodeUnknownEffect(Schema.Array(Answer))(req.body.answers)
const closing = yield * HistoryCheck.cancelAllPending(storedHistory, "user moved on")
return httpConversation(answers, {
  history: [...storedHistory, ...closing, Items.userText(req.body.message)],
})
```

`cancelAllPending` returns ready-to-append outputs, a `Cancelled` error
each. Use it whenever a checkpoint, timeout, or new user message could
leave `function_call`s without matching outputs.

## Queue variant (enhancement)

For long-lived connections where answers arrive over time. Safe calls
start immediately. Gated calls emit `ApprovalRequested`, then each one
waits until its specific answer lands on the queue.

```ts
// Inside fromQueue: once a gated call's answer (or the timeout) arrives.
Match.value(settled).pipe(
  Match.tagsExhaustive({
    Approve: () => Toolkit.run(toolkit, [call]),
    Deny: ({ reason }) => Stream.fromEffect(close(call, denied(reason))),
    Cancelled: (cancelled) => Stream.fromEffect(close(call, cancelled)),
  }),
)

onTurnComplete((turn) =>
  Effect.sync(() => {
    const calls = Turn.getToolCalls(turn)
    if (calls.length === 0) return stop()
    // Stream.unwrap supplies the Scope the router fiber lives in: it
    // stays alive as long as the consumer pulls.
    return Stream.unwrap(fromQueue(isSensitive, answers)(calls)).pipe(
      Toolkit.next(toolkit, current, turn),
    )
  }),
)
```

The consumer side typically taps `ApprovalRequested` events, offers
answers onto the same queue (the demo uses `demoAnswer`), and renders
`Output` results as they arrive.

## What you get in `state.history`

Whatever the path (approved, denied, cancelled), every gated call ends up
with a `function_call_output` carrying typed parts:

| Answer / outcome      | `output`                                                     |
| --------------------- | ------------------------------------------------------------ |
| Approved + executed   | The tool's own return value.                                 |
| Denied                | `{ "_tag": "Denied", "message": "..." }`, `isError: true`    |
| Cancelled / timed out | `{ "_tag": "Cancelled", "message": "..." }`, `isError: true` |
| Undeclared tool error | Fails `Toolkit.run`'s stream (declare it in `failureSchema`) |

History stays well-formed; the model reads the closing outputs on the next
turn and self-corrects if needed.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/tool-call-approval/run.ts
```

The runner drives the queue variant since it's the more visual demo
(simulated user offering answers after a delay). The HTTP variant is
better exercised by tests or in a real HTTP handler.

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/tool-call-approval/recipe.ts).
