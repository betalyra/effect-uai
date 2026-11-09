# Typed pending calls: every tool call handled, checked by the compiler

Status: direction agreed, details open. After 0.19. Follows
`plans/tool-output-redesign.md` (R6: `Tool.declare` goes, `run` becomes
optional). Until then, handling calls to tools without `run` is the app's job
and not checked by the types.

## The problem

After a turn, every tool call the model made needs an outcome before the next
model call, or the provider rejects the request. Some calls can't get one in
the same turn:

- **Tools without `run`**: signals (`escalate`, `finish`) change the loop's
  course; tools answered elsewhere (`ask_user`) wait for the page.
- **Calls the app holds back for approval**: `send_email` has `run`, but this
  call waits for a person first (app policy, any rule).

Today nothing makes the app handle either. A forgotten case surfaces as a
misleading `UnknownTool` for the model, or as a provider 400 one turn later.
Holding back calls is done by hand: filter, park in a `Ref`, `concat(stop())`.

## The idea

Make the calls a stream and handle them with pipe steps, each doing one thing.
Unhandled calls to tools without `run` stay in the stream's type, like
unhandled errors in Effect: `catchTag` / `catchTags` take them out, and
`Toolkit.next` refuses a stream with any left.

```ts
onTurnComplete((turn) =>
  Toolkit.calls(toolkit, turn).pipe(
    Toolkit.defer(needsApproval), // app policy: these calls wait for a person
    Toolkit.execute(toolkit), // calls with run: partials and outcomes
    Toolkit.handleCalls({
      // only tools without run are left: forced by the types
      ask_user: () => Toolkit.wait,
      escalate: ({ input }) => Toolkit.redirect({ tier: "strong", question: input.question }),
      finish: ({ input }) => Toolkit.end(input.report),
    }),
    Toolkit.next(toolkit, state, turn), // outcomes into history; decides how the loop goes on
  ),
)
```

Leave out `finish`:

```
✗ Toolkit.next: calls to "finish" are not handled (Toolkit.handleCall / handleCalls)
```

| Step                           | What it does                                              | In the types                                  |
| ------------------------------ | --------------------------------------------------------- | --------------------------------------------- |
| `Toolkit.calls(toolkit, turn)` | every call of the turn, as a stream                       | one member per tool                           |
| `Toolkit.defer(predicate)`     | marks matching calls as waiting                           | unchanged: which calls wait is policy         |
| `Toolkit.execute(toolkit)`     | runs every call that has `run` and isn't waiting          | calls to tools without `run` become `Pending` |
| `Toolkit.handleCall(s)`        | turns `Pending` calls into directives, like `catchTag(s)` | removes them                                  |
| `Toolkit.next(toolkit, s, t)`  | outcomes into history, then one decision for the loop     | refuses a stream with `Pending` left          |

`Toolkit.run(toolkit, calls)` stays as the shorthand for
`Stream.fromIterable(calls).pipe(Toolkit.execute(toolkit))`. Loops without
approvals and without tools that lack `run` don't change.

## Approvals stay app code

`defer` takes any predicate: by name, by pattern (MCP `helpdesk__write_*`), by
argument (refunds over 20 EUR), as an Effect if it decodes arguments. It only
marks calls; nothing is filtered by hand, so no call can get lost between a
partition and a stop.

Resuming is unchanged: the decisions design (`ToolDecision.make`, `byTool`,
`closesWith`, `Toolkit.close`) with the exhaustive `Match` over `answered`.
Approved calls run with `Toolkit.run`, denied ones are closed, `ask_user` gets
its typed answer with `Toolkit.complete`.

Where the types help:

- **Turn side**: calls to tools without `run` must be handled (`Pending`).
- **Resume side**: every decision tag must be handled (`Match.tagsExhaustive`).
- **Not checked, on purpose**: which calls wait. That is the app's policy.

## Types

```ts
// A call of the turn, typed per tool (unknown names: tool is string).
export type Call<Name extends string> = {
  readonly _tag: "Call"
  readonly tool: Name
  readonly call: ToolCall
}

// What execute emits for a call to a tool without run: input decoded.
export type Pending<Name extends string, Input> = {
  readonly _tag: "Pending"
  readonly call: ToolCall
  readonly tool: Name
  readonly input: Input
}

type PendingOf<T extends Toolkit> = {
  [K in keyof T & string]: T[K] extends {
    readonly run?: undefined
    readonly inputSchema: ToolInputSchema<infer I>
  }
    ? Pending<K, I>
    : never
}[keyof T & string]
```

A handler returns a **directive**, never a loop step (see "Why directives"):

```ts
export type Directive<S, R> =
  | Outcome // answer or close the call now: it goes into history like any outcome
  | Wait // the call stays open; the run ends after the others finish
  | Redirect<S> // continue the loop with this state instead
  | End<R> // end the loop, with an optional result
```

`defer` produces `Wait` for each matching call. Constructors: `Toolkit.wait`,
`Toolkit.redirect(state)`, `Toolkit.end(result?)`; an outcome comes from
`Toolkit.close(toolkit, "tool", call, error)` or a typed
`Toolkit.complete(toolkit, "tool", call, value)`.

Handlers, mirroring Effect:

```ts
Toolkit.handleCall("escalate", (p: Pending<"escalate", EscalateArgs>) => Effect<Directive<S, R>>) // like catchTag
Toolkit.handleCalls({ escalate: ..., ask_user: ... }) // like catchTags
Toolkit.handleRest((p: Pending<string, unknown>) => ...) // like catchAll, for loosely typed toolkits
```

`Toolkit.next` requires that no `Pending` is left:

```ts
export const next: <S, R>(
  toolkit,
  state: S,
  turn,
) => <A extends Tagged, E, Rq>(
  stream: Stream<A, E, Rq> & NoPending<A>, // a readable error, like Toolkit.make's duplicate names
) => Stream<Loop.Step<Exclude<A, Directive<S, R>>, S>, E | Schema.SchemaError, Rq>
```

## Why directives, not loop steps

The loop ends an iteration at the first `Next` or `Stop` in the stream and
cancels the rest. If the `escalate` handler emitted `Loop.next(...)` directly,
a `search` running in the same turn would be cancelled mid-flight and its
outcome lost, and the `Next` that `Toolkit.next` builds from the history would
never arrive.

With directives, every step runs to completion, all outcomes are collected,
and `Toolkit.next` decides once, at the end of the stream:

| Directives seen                | `Toolkit.next` emits                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| a `Redirect`                   | `Next(redirect state)`                                                    |
| an `End`, no `Redirect`        | outcomes into history, then `Stop` (with the result)                      |
| a `Wait`, neither of the above | outcomes into history, then `Stop`; a `Waiting { calls }` value before it |
| only outcomes                  | outcomes into history, then `Next(state)` (today's behavior)              |

The precedence is a fixed rule. An app that wants another rule uses
`Toolkit.continueWith(build)` directly: `build` receives the outcomes and the
directives and returns the next step. `next` stays `continueWith` with the
default rule, so nothing is hidden that can't be replaced.

## Developer experience

- **Pipe steps, one job each**, readable top to bottom; no option bags.
- **A new tool without `run` breaks the build** at `Toolkit.next` until the loop
  handles it, with one error naming the tool.
- **Toolkits without such tools and loops without approvals change nothing**:
  `Toolkit.run(toolkit, calls)` as today.
- **Waiting reaches the page through the stream.** `Waiting { calls }` becomes
  `run-interrupted` in `Projection`, with reason `"approval"` (deferred) or
  `"input"` (no `run`); `ask_user`'s answer is typed by its `outputSchema`
  (`contract.success`).

## Dynamic tools

- **MCP tools always have `run`** (the server executes them): never pending.
  Gating them is `defer` with any predicate.
- **Composed toolkits** (yours plus MCP) keep the types of your part; only your
  tools without `run` need handlers.
- **Toolkits typed loosely** (`Toolkit.fromArray` with tools without `run`):
  `Pending<string, unknown>` stays until `handleRest` takes it.
- **Provider tools** never reach the app as calls; their items are part of the
  turn and carried over by `next`.
- **Unknown names** (the model invents one) are not pending: `execute` closes
  them with `UnknownTool`, which the model can fix.

## Implications

- `Toolkit.Event` gains `Pending`, plus the `Call` / `Wait` / directive members;
  consumers that match on events (`Projection`, `recipe-kit/render`, the ai-sdk
  stream) handle or ignore them.
- `Toolkit.next` and `continueWith` gain the directive rule and the
  `NoPending` constraint; their signatures get more complex.
- `Redirect` carries the loop's state type `S`, so handlers are typed against
  the loop they run in.
- The examples lose their hand-written gating (`filter`, `parked` ref,
  `concat(stop())`).

## Edge cases

- **Enforcement only on the `next` path.** Code that collects the stream itself
  (`Stream.runCollect`, tests, scripts) is not forced to handle pending calls.
- **Code generic over a toolkit.** A helper typed `<T extends Toolkit>` can't
  know `PendingOf<T>`, so it must either `handleRest` or constrain `T` to
  toolkits whose tools all have `run`.
- **`Redirect` and work already done.** Tools that ran in the same turn had
  their effects (an email went out). A redirect from fresh history drops their
  outcomes, so it should be able to build on the appended history:
  `Toolkit.redirect((history) => newState)`.
- **Invalid input to a tool without `run`.** Decoding fails before any handler:
  closed with `InputInvalid` for the model, like for tools with `run`.
- **An Effect predicate in `defer`** runs before execution: ordering and
  concurrency between calls get slightly more involved.
- **Resuming a `Wait`.** The run stops with calls still open. The next request
  must answer them (or give them a placeholder) before calling the model, as
  approvals do today; `HistoryCheck` stays the safety net.
- **Two breaking releases.** R6 removes `Tool.declare` in 0.19; this changes
  `Toolkit.Event` and `next` again later.

## Open questions

1. Names: `handleCall` / `handleCalls` / `handleRest`, or closer to Effect
   (`catchCall`, `catchCalls`)? `defer`, `execute`, `calls`?
2. `Toolkit.calls` next to `Turn.getToolCalls` (typed stream vs plain array):
   keep both?
3. Several `Redirect`s in one turn: first wins, or a type-level "at most one"?
4. Should `End` carry a typed result into `loopOver` / `loopWithState`?
5. Should `Waiting` say why each call waits (deferred vs no `run`), so
   `Projection` picks the interrupt reason by itself?
