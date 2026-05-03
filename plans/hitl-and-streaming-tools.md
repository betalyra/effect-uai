# Plan — HITL and Streaming Tools

Ship the resolver-based tool execution model and the streaming-tool model that
fell out of [experiments/streaming-hitl-spike/proposed](../experiments/streaming-hitl-spike/proposed).
Both are designed around one primitive (`executeWithResolver`), one structured
result type (`ToolResult`), and a small set of named conveniences and combinators.

## Context

We need two related capabilities the SDK doesn't currently support cleanly:

1. **Streaming tools** — tools whose `run` is a `Stream<Event>` rather than an
   `Effect<Output>`. Sub-agents, slow downloads with progress, recipe streamers.
   Each event flows through to the consumer in real time; a `finalize(events)`
   reduces the collected events to the model-facing output.

2. **Human-in-the-loop tool calls** — gate sensitive calls (`send_email`,
   `delete_database`, `bulk_email`) on a user verdict before executing. Works
   over a long-lived channel (WebSocket-style, verdict queue) and over
   request-shaped HTTP (verdicts bundled in a payload).

Both share an underlying need: a Stream of `ToolEvent`s, real-time intermediates,
synthesized outputs for the cases where execution is skipped, and a small
vocabulary for "what happened" that stays stable across recipes.

The strictness survey ([experiments/streaming-hitl-spike/tool-call-strictness.md](../experiments/streaming-hitl-spike/tool-call-strictness.md))
documents the wire invariant that motivates the synthesizer + reconciliation
primitives: every `function_call` in history needs a matching
`function_call_output` before the next provider request, on every major
provider except Groq's incidental leniency. There is no escape valve.

## Goals

- Ship a `Resolver`-based executor that decouples "what to do with this call"
  from "transport / approval mechanism."
- Ship `StreamingTool` as a peer constructor to `Tool`. The executor handles
  both kinds via internal dispatch; resolvers don't know which kind they're
  triggering.
- Ship one structured result type (`ToolResult`) carried through the executor
  output stream, with an explicit wire-conversion helper (`toFunctionCallOutput`)
  applied at the recipe boundary.
- Ship the canonical synthesizers (`denied`, `cancelled`) plus a generic
  `rejected(call, kind, reason)` for everything else.
- Ship the history-reconciliation helpers (`findUnansweredCalls`,
  `cancelAllPending`) as explicit, recipe-callable primitives.
- Update existing recipes (notably `tool-call-approval`, `basic-usage`) to use
  the new shape. Add a new HTTP variant of `tool-call-approval` and a streaming
  sub-agent recipe.

## Non-goals

- Per-tool typed `ToolResult.value` via const-typed records. Discussed and
  declined: the cost in generic noise grows with toolkit size, MCP tools are
  inherently `unknown` at our type layer, and most production code treats tool
  values opaquely. Recipes that need typed access for one specific tool can do
  a runtime narrow + cast at the call site.
- `ToolDecision.ExecuteWith(input)`. Discussed and dropped: argument
  rewriting belongs in a `Resolver→Resolver` wrapper, not in the decision type.
- Named `permissionDenied` / `timeout` synthesizers. Both collapse into
  `rejected(call, kind, reason)` with a recipe-chosen kind string.
- Implicit history reconciliation inside the recipe loop. The recipe trusts
  what the entry point hands it; reconciliation is a transport-level concern
  the HTTP handler / WebSocket shim handles before invoking the recipe.

## Building blocks

The lib surface, grouped by concern. All shapes are validated in
[experiments/streaming-hitl-spike/proposed/lib](../experiments/streaming-hitl-spike/proposed/lib).

### Tool kinds

```ts
// Existing - unchanged.
Tool.Tool<Name, Input, Output, R>

// New constructor, peer to Tool.make:
Tool.streaming<Name, Input, Event, Output, R>({
  name, description, inputSchema, run, finalize, strict
}): StreamingTool<Name, Input, Event, Output, R>
//   run: (input: Input) => Stream<Event, unknown, R>
//   finalize: (events: ReadonlyArray<Event>) => Output

// Union for the executor:
type Tool.AnyKindTool = AnyStreamingTool | AnyPlainTool
```

### Result types

```ts
type ToolResult =
  | { _tag: "Value";   call_id: string; tool: string; value: unknown }
  | { _tag: "Failure"; call_id: string; tool: string; kind: string; reason?: string }

type ToolDecision =
  | { _tag: "Execute" }
  | { _tag: "Reject"; result: ToolResult }

type ToolEvent =
  | { _tag: "ApprovalRequested"; call_id; tool; arguments }
  | { _tag: "Intermediate";      call_id; tool; data: unknown }
  | { _tag: "Output";            result: ToolResult }
```

`output.output` (the wire string) is `string`; `reason` (inside Failure) is
`string`. Both decisions are intentional: wire-faithfulness for `output`,
correct-by-construction JSON-serializability for `reason`. Recipes that want
structured detail call `JSON.stringify(detail)` themselves.

### Synthesizers

```ts
// Generic (open kinds):
rejected(call, kind: string, reason?: string): ToolResult

// Two named conveniences for the operationally distinct cases:
denied(call, reason?): ToolResult     // "no" came back
cancelled(call, reason?): ToolResult  // no answer came back

// For the executor's internal use; exported for resolver authors:
executionError(call, reason: string): ToolResult  // tool ran and failed
```

### Wire conversion

```ts
toFunctionCallOutput(r: ToolResult): Items.FunctionCallOutput
```

The single boundary recipes hit when threading results into history. One
explicit `.map(toFunctionCallOutput)` at the recipe; the rest of the
pipeline stays structured.

### The executor primitive

```ts
type Resolver = (call: FunctionCall) => Effect<ToolDecision>

executeWithResolver(
  tools: ReadonlyArray<AnyKindTool>,
  calls: ReadonlyArray<FunctionCall>,
  resolve: Resolver,
): Stream<ToolEvent>

// Trivial degenerate case (rename of today's executeAllSafe; see below):
executeAll(tools, calls): Stream<ToolEvent>
//   = executeWithResolver(tools, calls, () => Effect.succeed(execute))
```

Per-call dispatch:

- Streaming tool, `Execute` → real-time `Intermediate` events tapped via
  `Ref` + `Stream.concat`, then one synthetic `Output` carrying
  `Value(finalize(events))`.
- Plain tool, `Execute` → parse → validate → `tool.run(input)` → one
  `Output` with `Value(output)`.
- Any tool, `Reject(result)` → one `Output` with the supplied `result`,
  no execution.
- Unknown tool name → one `Output` with `rejected(call, "unknown_tool", ...)`.
  Single bad call_id does not kill the whole turn (LLMs hallucinate, MCP
  tools come and go).
- Tool errors / schema-validation failures → one `Output` with
  `executionError(call, ...)`.

All calls dispatch concurrently via `Stream.flatMap({ concurrency: "unbounded" })`.

### Resolvers (recipe-side helpers)

```ts
// Long-lived channel transport. Returns a setup Effect that wires per-call
// Deferreds + a router fiber, then yields { resolve, announce }.
fromVerdictQueue(predicate, queue: Queue<Verdict>)(calls): Effect<{
  resolve: Resolver
  announce: Stream<ToolEvent>  // ApprovalRequested events for gated calls
}>

// Request-shaped transport. Pure function; missing entries → cancelled.
fromApprovalMap(predicate, approvals: Map<call_id, ApprovalMapEntry>): Resolver
```

### Combinators

```ts
withPermissions(inner, canApprove, onForbidden?): Resolver
//   canApprove runs BEFORE inner; failures emit Reject(onForbidden(call)).
//   Default onForbidden: rejected(call, "permission_denied", "missing permissions")

withFallback(inner, recoverable, fallback): Resolver
//   When inner returns Reject and recoverable(result) is true, run fallback.
//   Otherwise pass the original Reject through.
```

### Loop helpers

```ts
// General primitive (subsumes Loop.nextAfter):
nextAfterFold<A, B, S>(stream, initial, reduce, build): Stream<Loop.Event<A, S>>

// Specialization: collect ToolResults from Output events, hand to build,
// emit Loop.next(build(results)) at end-of-stream.
nextStateFrom<S>(
  stream: Stream<ToolEvent>,
  build: (results: ReadonlyArray<ToolResult>) => S,
): Stream<Loop.Event<ToolEvent, S>>
```

### History reconciliation

```ts
findUnansweredCalls(history): ReadonlyArray<FunctionCall>
isReconciled(history): boolean
cancelAllPending(history, reason?): ReadonlyArray<ToolResult>
```

Recipe authors call these at known transition points (new request arrived,
checkpoint loaded, timer fired). Not invoked from inside the recipe loop.

## Naming changes

| Today                     | New                  | Why                                                             |
| ------------------------- | -------------------- | --------------------------------------------------------------- |
| `Toolkit.executeAllSafe`  | `Toolkit.executeAll` | "Safe" suffix predates the structured-result design; with `ToolResult` carrying `Failure` variants, every executor call is "safe" by construction. The shorter name reads cleaner. |
| `Toolkit.executeOne`      | `Toolkit.executeOne` | Keep. Single-call execution helper still makes sense.            |

The new `executeWithResolver` is a sibling of `executeAll`, not a replacement.
`executeAll` stays as the no-resolver shorthand.

## Module placement

| Block                                         | File                                            |
| --------------------------------------------- | ----------------------------------------------- |
| `Tool.streaming`, `AnyKindTool`, `isStreamingTool` | extend `packages/core/src/tool/Tool.ts`     |
| `ToolEvent`, type guards                      | new `packages/core/src/tool/ToolEvent.ts`       |
| `ToolResult`, `ToolDecision`, synthesizers, `toFunctionCallOutput` | new `packages/core/src/tool/Outcome.ts` |
| `executeWithResolver`, `executeAll`           | extend `packages/core/src/tool/Toolkit.ts`      |
| `fromVerdictQueue`, `fromApprovalMap`, `Verdict`, `withPermissions`, `withFallback` | new `packages/core/src/tool/resolvers.ts` |
| `nextAfterFold`                               | extend `packages/core/src/loop/Loop.ts`         |
| `nextStateFrom`                               | new `packages/core/src/tool/loop-helpers.ts` (or alongside Toolkit) |
| `findUnansweredCalls`, `isReconciled`, `cancelAllPending` | extend `packages/core/src/domain/Items.ts` (operates on `Item`) |

## Recipes

### Existing recipes that must change

- **`recipes/basic-usage`** — rename `Toolkit.executeAllSafe` → `Toolkit.executeAll`.
  Outputs are now `ToolResult[]` rather than `FunctionCallOutput[]`; recipe
  applies `.map(toFunctionCallOutput)` when threading into history. Verify
  README snippet matches.

- **`recipes/tool-call-approval`** — rewrite under the resolver model. Today's
  recipe uses `executePartitioned` + `denied` and emits an
  `awaiting_approval` event tagged differently from our new `ApprovalRequested`.
  The new shape:
  ```ts
  const { resolve, announce } = yield* fromVerdictQueue(isSensitive, verdicts)(calls)
  const events = Stream.merge(announce, executeWithResolver(allTools, calls, resolve))
  return nextStateFrom(events, (results) => ({
    ...next,
    history: [...next.history, ...results.map(toFunctionCallOutput)],
  }))
  ```
  Update README, tests, and the live demo accordingly.

### New recipes to add

- **`recipes/tool-call-approval-http`** — request-shaped variant of the same
  recipe using `fromApprovalMap`. Demonstrates the orphan-reconciliation entry
  point (HTTP handler calls `cancelAllPending` on the stored history before
  invoking the recipe). Companion to the WebSocket-style recipe.

- **`recipes/streaming-tool-subagent`** — sub-agent invoked as a streaming tool.
  Inner agent's `text_delta` events flow through to the consumer as
  `Intermediate` events; the outer model sees the joined string via
  `finalize(events)`. Killer use case for `Tool.streaming`.

### Recipes affected by `executeAll` rename

Audit pass: any recipe calling `Toolkit.executeAllSafe` gets the rename.

## Migration order

Implement in this order to keep CI green at every step:

1. **Add new primitives in core, side-by-side with existing.**
   - `Tool.streaming` constructor, `AnyKindTool` union, `isStreamingTool`.
   - `ToolEvent`, `ToolResult`, `ToolDecision`, synthesizers, `toFunctionCallOutput`.
   - `executeWithResolver` and the new `executeAll`.
   - Resolvers and combinators in `resolvers.ts`.
   - `nextAfterFold` on `Loop`; `nextStateFrom` near the executor.
   - History helpers on `Items`.
   - Unit tests for each block (port from spike).
2. **Rename `executeAllSafe` → `executeAll` (with deprecation re-export).**
   - Update internal callers.
   - Keep `executeAllSafe` as a deprecated alias for one minor version so
     downstream users get a single deprecation warning rather than a hard break.
3. **Update existing recipes.**
   - `basic-usage`: rename + update README + verify tests pass.
   - `tool-call-approval`: rewrite under resolver model. Replace
     `awaiting_approval` events with `ApprovalRequested`; update README, tests,
     demo.
4. **Add new recipes.**
   - `tool-call-approval-http`: new recipe + tests + README, including the
     entry-point reconciliation pattern.
   - `streaming-tool-subagent`: new recipe + tests + README.
5. **Sweep for stragglers.**
   - Update `recipes/README.md` landing page.
   - Move `tool-call-approval` from "Proposed" to "Existing" in
     `plans/recipes.md`. Add the two new recipes to "Existing".
   - Update `webpage/src/components/RecipesSection.tsx` to register the new
     recipes.
6. **Decommission spikes.**
   - Once tests on real code mirror the spike's coverage, delete:
     - `experiments/streaming-tool-spike/`
     - `experiments/streaming-hitl-spike/`
     - `experiments/partition-spike/`
   - Per memory: spikes must not become workspace deps of shipped code; once
     core has the equivalent surface, spike folders are dead weight.
7. **Drop the deprecated `executeAllSafe` alias** in the next minor after step 2.

## Open questions to resolve during implementation

- **`Toolkit.defaultRepair` signature.** Currently returns `FunctionCallOutput`.
  Replace with a `ToolResult.Failure`-returning version next to `executionError`?
  Or keep both for back-compat and let internal code use the new one?
  Suggest: replace, no parallel API.
- **`Toolkit.toDescriptors` for mixed tools.** Today only handles plain tools.
  Extend to take `ReadonlyArray<AnyKindTool>` so streaming tools render to
  descriptors uniformly. Same JSON-schema extraction, `_kind` field is dropped
  in the output.
- **Where exactly does `nextStateFrom` live?** Loop module (since it returns
  `Stream<Loop.Event<...>>`) or Toolkit module (since it specialises on
  `ToolEvent`)? Probably Toolkit; `nextAfterFold` is the Loop-side primitive.
- **Public surface for `Verdict` and `ApprovalMapEntry` types.** They're
  recipe-side conventions, not core-shaped. Keep in `resolvers.ts` next to
  the resolver constructors that use them.
- **Public surface for the kind constants** (`"denied"`, `"cancelled"`,
  `"unknown_tool"`, `"execution_error"`, `"permission_denied"`). Either keep
  as bare strings (open) or export a `ResultKind` namespace with the canonical
  ones. Lean: bare strings, document the canonical set.

## Out-of-scope follow-ups (track separately)

- Per-tool typed `ToolResult.value` via const-typed records.
- `ToolDecision.ExecuteWith(input)` / argument-rewriting combinator.
- Schema-validated `ToolResult` (would let core validate `kind`/`reason`
  shapes at synthesis time).
- Async resolver-side announcement events (resolver as `Stream<...>` rather
  than `Effect<ToolDecision>`). Current `fromVerdictQueue` handles announces
  via a separate stream merged at the recipe; if more shapes need
  pre-decision events, revisit.
