# Typed pending calls: every tool call handled, checked by the compiler

Status: idea for after 0.19, not decided. Follows `plans/tool-output-redesign.md`
(R6: `Tool.declare` goes, `run` becomes optional). Until then, handling calls
to tools without `run` is the app's job and not checked by the types.

## The problem

After a turn, every tool call the model made needs an outcome before the next
model call, or the provider rejects the request. `Toolkit.run` produces outcomes
for tools with `run`. For a tool without `run` it can't: the call means
something only the app knows.

- **Signals** (`escalate`, `finish`): the loop changes course.
- **Answered elsewhere** (`ask_user`): the call waits; the page answers it later
  with a typed value.

Today nothing makes the app handle these. A forgotten case surfaces as a
misleading `UnknownTool` for the model, or as a provider 400 one turn later.

## The idea

Treat unhandled calls like unhandled errors in Effect. `Effect.catchTag` takes
one error out of the error channel, `catchTags` several; whatever is left stays
in the type until something handles it.

Here, `Toolkit.run` emits a typed `Pending` event for every call to a tool
without `run`. The pending calls stay in the stream's element type until a
handler takes them out, and `Toolkit.next` only accepts a stream with none
left.

```ts
onTurnComplete((turn) =>
  Toolkit.run(toolkit, Turn.getToolCalls(turn)).pipe(
    Toolkit.handleCalls({
      escalate: ({ input }) => Toolkit.redirect({ tier: "strong", question: input.question }),
      ask_user: () => Toolkit.wait,
      finish: ({ input }) => Toolkit.end(input.report),
    }),
    Toolkit.next(toolkit, state, turn),
  ),
)
```

Leave out `finish`:

```
✗ Toolkit.next: calls to "finish" are not handled (Toolkit.handleCall / handleCalls)
```

## Types

```ts
// What run emits for a call to a tool without run: typed per tool, input decoded.
export type Pending<Name extends string, Input> = {
  readonly _tag: "Pending"
  readonly call: ToolCall
  readonly tool: Name
  readonly input: Input
}

// One member per tool without run.
type PendingOf<T extends Toolkit> = {
  [K in keyof T & string]: T[K] extends { readonly run?: undefined; readonly inputSchema: ToolInputSchema<infer I> }
    ? Pending<K, I>
    : never
}[keyof T & string]

// run's events: partials and outputs as today, plus the pending calls.
export type Event<T extends Toolkit> = ToolEvent.ToolEvent<...> | PendingOf<T>
```

A handler returns a **directive**, never a loop step (see "Why directives"):

```ts
export type Directive<S, R> =
  | Outcome // answer or close the call now: it goes into history like any outcome
  | Wait // the call stays open; the run ends after the others finish
  | Redirect<S> // continue the loop with this state instead
  | End<R> // end the loop, with an optional result
```

Constructors: `Toolkit.wait`, `Toolkit.redirect(state)`, `Toolkit.end(result?)`.
An outcome comes from the existing `Toolkit.close(toolkit, "tool", call, error)`
or a typed `Toolkit.complete(toolkit, "tool", call, value)`.

Handlers, mirroring Effect:

```ts
// one tool, like catchTag
Toolkit.handleCall("escalate", (p: Pending<"escalate", EscalateArgs>) => Effect<Directive<S, R>>)
// several, like catchTags
Toolkit.handleCalls({ escalate: ..., ask_user: ... })
```

Each handler removes its `Pending<Name>` from the element type and adds
`Directive`. `Toolkit.next` requires that no `Pending` is left:

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

With directives, every handler runs to completion, all outcomes are collected,
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

- **No sorting step.** `Turn.getToolCalls(turn)` stays; every call goes to `run`.
  `Toolkit.calls` (planned in R6) isn't needed.
- **A new tool without `run` breaks the build** at `Toolkit.next` until the loop
  handles it, with one error naming the tool.
- **Toolkits without such tools change nothing**: no `Pending` in the type,
  no handler needed, `basic-usage` unchanged.
- **Each handler is small and local**, like a `catchTags` branch.
- **Waiting reaches the page through the stream.** `Waiting { calls }` is a
  value `Projection` can turn into `run-interrupted` (a new interrupt reason,
  `"input"`); the page answers with a value typed by the tool's `outputSchema`
  (`contract.success`).

## Dynamic tools

- **MCP tools always have `run`** (the server executes them): never pending.
- **Composed toolkits** (yours plus MCP) keep the types of your part; only your
  tools without `run` need handlers.
- **Toolkits typed loosely** (`Toolkit.fromArray` with tools without `run`):
  names are only known at runtime, so `Pending<string, unknown>` stays in the
  type until a catch-all `Toolkit.handleRest(f)` takes it, like `catchAll`.
- **Unknown names** (the model invents one) are not pending: `run` closes them
  with `UnknownTool`, which the model can fix.

## Implications

- `Toolkit.Event` gains `Pending`; consumers that match on events
  (`Projection`, `recipe-kit/render`, the ai-sdk stream) handle or ignore it.
- `Toolkit.next` and `continueWith` gain the directive rule and the
  `NoPending` constraint; their signatures get more complex.
- `Redirect` carries the loop's state type `S`, so handlers are typed against
  the loop they run in.
- Approvals stay separate (runtime policy over tools with `run`). Open: whether
  a held call could also become a `Pending` (`Toolkit.run(toolkit, calls, { hold })`)
  so approvals and `ask_user` share one waiting path.

## Open questions

1. Names: `handleCall` / `handleCalls` / `handleRest`, or closer to Effect
   (`catchCall`, `catchCalls`)?
2. Several `Redirect`s in one turn: first wins, or a type-level "at most one"?
3. Should `End` carry a typed result into `loopOver` / `loopWithState`?
4. Do signals need their input decoded before the handler (as above), and what
   happens when decoding fails: `InputInvalid` to the model, like `run`?
5. Unify held approvals with `Pending` (see Implications)?
