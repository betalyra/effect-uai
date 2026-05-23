# Consistent naming — analysis & proposal

> Independent analysis by Claude. The companion file `consistent-naming.md`
> is a separate proposal (from a different reviewer); I haven't aligned with
> it on purpose, so the two can be diffed.

## How I read the surface

I walked the recipe code (`basic-usage`, `agentic-loop`, `tool-call-approval`,
`streaming-tool-output`, `auto-compaction`, `mid-stream-abort`, `model-retry`,
`model-escalation`, `multi-model-fallback`, `pause-resume`, `modify-output-stream`,
`structured-output`, `streaming-structured-output`) and the public
exports from `Loop`, `Tool`, `Toolkit`, `Outcome`, `ToolEvent`, `Turn`,
`Items`, `LanguageModel`, `Resolvers`. The library is mostly well-named.
Friction shows up in three specific places:

1. **Three layered "output/result" terms sit on top of each other.**
   `ToolEvent.Output` (envelope) → `ToolResult.Value | Failure` (structured) →
   `FunctionCallOutput` (wire history item). All three appear in the same
   four-line block in basic-usage. Readers can't tell at a glance which one
   they're looking at.

2. **Wire vocabulary leaks into developer code.** Recipes call `Turn.functionCalls(turn)`
   and `toFunctionCallOutput(result)` — but the developer mental model is
   "the model asked for tools". `function_call` is provider wire format
   (OpenAI Responses); the public surface should speak in "tool calls".

3. **`Loop` exposes too many `stop*`/`next*` helpers** with overlapping
   names. Five of them (`stop`, `stopEvent`, `stopAfter`, `stopWith`,
   `stopWithAfter`) and three `next*` variants. Three or four are load-bearing;
   the rest are essentially exposed internals.

A few smaller name conflicts compound these (`Loop.value` is too generic at
call sites, `Outcome` module hides `ToolResult`, `Toolkit` is a phantom type,
`AnyKindTool` reads backwards). Below: a table with `Rename` / `Keep` /
`Optional` / `Remove` decisions, then before/after sketches focused on the
high-leverage changes.

---

## Rename table

Decision legend: **Keep** (name is fine), **Rename** (recommended change),
**Optional** (improvement but lower priority), **Remove** (deprecate path).

### `Loop`

| Current | Proposed | Decision | Reason |
| --- | --- | --- | --- |
| `loop(initial, body)` | `loop` | Keep | Core verb, short, scoped by namespace. |
| `loopFrom(input, initial, body)` | `loopOver(input, initial, body)` | Rename | `loopFrom` reads as "loop from…?". `loopOver` says "iterate **over** this stream of inputs", which is what it does. |
| `loopWithState(initial, body)` | `loopWithState` | Keep | Accurate; returns `{ stream, state }`. |
| `onTurnComplete(then)` | `onTurnComplete` | Keep | Reads well inside `.pipe(...)`. The fact that the callback returns a stream is slightly surprising but justifiable. |
| `Event<A, S>` (the type) | `Step<A, S>` | Rename | `Loop.Event` collides with `TurnEvent` and `ToolEvent` (both of which actually flow through the stream). A `Step` is the right metaphor: each chunk emitted by the body is one step of the iteration — emit, advance, or end. |
| `value(a)` (constructor) | `emit(a)` | Rename | At call sites (`model-escalation` does `value({ _tag: "tier_active", ... })`) the name says nothing. `emit` says "send this downstream". |
| `next(s)` | `next(s)` | Keep | Reads well — "go to next iteration with state `s`". |
| `stop` (the Stream) | `stop` | Keep | Used 12+ times across recipes; clear. |
| `stopEvent` (the bare constructor) | — | Remove from public surface | Internal. Recipes never use it. Build inside `Loop`, don't re-export. |
| `stopWith(state)` | `endWith(state)` | Rename | `stopWith(x)` reads "stop **using** x" (English "with" = instrumental). The variant actually means "end the loop **and surface** this final state". `endWith` removes the ambiguity and pairs with `loopWithState`'s "what state did we end on". |
| `nextAfter(stream, state)` | `thenNext(stream, state)` | Rename | `nextAfter` is hard to read in pipes: "next after this stream". `thenNext(stream, state)` parses as "stream these values, **then** advance with `state`" — same temporal order as written. (Data-last reads `stream.pipe(thenNext(state))`.) |
| `stopAfter(stream)` | `thenStop(stream)` | Rename | Same reasoning. `thenStop` pairs with `thenNext`. |
| `stopWithAfter(stream, state)` | `thenEndWith(stream, state)` | Rename | Pairs with `endWith`. Hides the awkward double suffix. |
| `nextAfterFold(stream, init, reduce, build)` | `foldThenNext(stream, init, reduce, build)` | Rename | Order matches what the function does: fold the stream, then continue. Also stops competing with `Toolkit.continueWith` for the same concept (see below). |

### `Tool`

| Current | Proposed | Decision | Reason |
| --- | --- | --- | --- |
| `Tool.make(spec)` | `Tool.make` | Keep | Idiomatic. |
| `Tool.streaming(spec)` | `Tool.streaming` | Keep | Pairs cleanly with `Tool.make`. |
| `Tool.fromEffectSchema` / `Tool.fromStandardSchema` | Keep | Keep | `from*` is the right verb. |
| `Tool.toDescriptors(tools)` | Keep | Keep | Clear converter name; canonical path. |
| `Tool.AnyKindTool` | `Tool.AnyTool` | Rename | `AnyKindTool` reads as "any-kind tool" but **is** the umbrella union. `AnyTool` = umbrella, `Tool` / `StreamingTool` already exist for the halves. `AnyPlainTool` becomes `AnyTool & {...}` if needed, but recipes don't reach for it. |
| `Tool.AnyPlainTool` | `Tool.AnyPlainTool` | Keep | Used internally by `Toolkit`; fine. |
| `Tool.AnyStreamingTool` | `Tool.AnyStreamingTool` | Keep | Same. |

### `Toolkit`

| Current | Proposed | Decision | Reason |
| --- | --- | --- | --- |
| `Toolkit.make(tools)` | — | Remove (or hide) | Wraps a `ReadonlyArray<Tool>` in `{ tools }` and is immediately destructured. Recipes don't use it; the `Toolkit<Tools>` type appears as a phantom. Drop it from docs; if anyone uses it, alias `Toolkit.make = (tools) => ({ tools })` for one cycle. |
| `Toolkit.toDescriptors(toolkit)` | — | Remove (or hide) | Duplicate of `Tool.toDescriptors(tools)`. Pick one path; `Tool.toDescriptors` already accepts mixed arrays. |
| `Toolkit.executeAll(tools, calls)` | `Tools.run(tools, calls)` or `Tool.executeCalls(tools, calls)` | Rename (with module move) | The function takes a list of tools, not a `Toolkit`. The receiver name lies. Options: rename to `Tool.executeCalls(tools, calls)` (keep `Tool` as the verb owner) or rename the module `Toolkit` → `Tools`. I prefer **module rename to `Tools`** because `Tool` is the singular constructor namespace and `Tools` is the plural verb namespace — clear seam. `Tools.run(tools, calls)` then reads naturally. |
| `Toolkit.continueWith(build)` | `Tools.collectResults(build)` | Rename | This is the most under-named function in the library. Today: `Toolkit.executeAll(...).pipe(Toolkit.continueWith(build))`. The function **collects every terminal `ToolEvent.Output`'s `ToolResult` into an array** and then emits `next(build(results))`. "continueWith" sounds like a loop primitive (and the actual loop continuation is buried inside). `collectResults(build)` says exactly what it does. The name also distinguishes it from the loop's `next`/`thenNext` family. |

### `ToolEvent` (the tagged enum)

| Current | Proposed | Decision | Reason |
| --- | --- | --- | --- |
| `ToolEvent.ApprovalRequested` | Keep | Keep | Precise. |
| `ToolEvent.Intermediate` | `ToolEvent.Progress` | Rename | "Intermediate" is the variant's *position* in the sequence, not its meaning. Looking at usage — sub-agent text deltas, file download `pct`, sandbox exec output — they're all **progress updates**. `Progress` describes content. (`Update` is another option but less specific.) |
| `ToolEvent.Output` | `ToolEvent.Done` | Rename | The envelope marks "this tool call is finished, here's its terminal result". `Output` collides with `FunctionCallOutput` and with the colloquial use of "output" for content. `Done` says terminal. Then the chain reads: `Progress*, Done(result)`. |
| `isIntermediate` / `isOutput` | `isProgress` / `isDone` | Rename (with variants) | Follow the variant rename. |

### `Outcome` module & `ToolResult`

| Current | Proposed | Decision | Reason |
| --- | --- | --- | --- |
| Module `Outcome` (path: `@effect-uai/core/Outcome`) | Module `ToolResult` (path: `@effect-uai/core/ToolResult`) | Rename | The module's central type **is** `ToolResult`. Import path should match: `import { toToolCallOutput } from "@effect-uai/core/ToolResult"`. "Outcome" is generic and doesn't aid discovery. |
| `ToolResult` (type) | `ToolResult` | Keep | The type itself is well-named. |
| `ToolResult.Value` | `ToolResult.Ok` | Rename | `Value` / `Failure` is asymmetric (`Value` is a kind of result; `Failure` is a *named outcome*). `Ok` / `Failure` (or `Success` / `Failure`) makes the pair symmetric. I prefer `Ok` for brevity at pattern-match sites. |
| `ToolResult.Failure` | `ToolResult.Failure` | Keep | Already symmetric on the failure side. |
| `valueResult(...)` (internal helper in Toolkit.ts) | `okResult(...)` | Rename (internal) | Match `Ok`. |
| `rejected(call, kind, reason)` | `failed(call, kind, reason)` | Rename | `rejected` collides with `Resolvers.ToolCallPlan.rejected` and with `Resolvers.reject` for **approval rejection** — two different rejections in the same surface area. `failed(call, kind, reason)` is unambiguous. (For approval, "rejected by policy" is `denied`, already correct.) |
| `denied(call, reason?)` | `denied` | Keep | Specific to approval denial. |
| `cancelled(call, reason?)` | `cancelled` | Keep | Specific to user/system cancellation. |
| `executionError(call, reason)` | `executionError` | Keep | Precise. |
| `toFunctionCallOutput(result)` | `toToolCallOutput(result)` | Rename | The recipe sentence is "execute calls, build results, turn results into history items". `toToolCallOutput` matches the new `ToolCall` / `ToolCallOutput` vocabulary. Old name lives as deprecated alias for one cycle (the underlying schema `Items.FunctionCallOutput` keeps its name — see below). |

### `Items` (history)

| Current | Proposed | Decision | Reason |
| --- | --- | --- | --- |
| `Items.Item` | `Items.HistoryItem` | Rename | `Item` is too generic at usage sites: `ReadonlyArray<Items.Item>`. `ReadonlyArray<Items.HistoryItem>` is self-explanatory. |
| `Items.userText` / `systemText` / `assistantText` | Keep | Keep | Concise, used everywhere, no confusion. |
| `Items.FunctionCall` (the schema/type) | `Items.FunctionCall` + type alias `Items.ToolCall = Items.FunctionCall` | Keep + alias | The schema name **must** stay `function_call` for OpenAI wire compat (the `type` field is `"function_call"`). But export a type alias `ToolCall = FunctionCall` and a constructor predicate `isToolCall = isFunctionCall` so recipe code never has to type "Function". |
| `Items.FunctionCallOutput` | Keep + alias `Items.ToolCallOutput` | Keep + alias | Same reason. The wire `type: "function_call_output"` stays; the developer-facing alias is `ToolCallOutput`. |
| `Items.isFunctionCall` / `isFunctionCallOutput` | Add `isToolCall` / `isToolCallOutput` aliases | Add aliases | Same reasoning. |

### `Turn`

| Current | Proposed | Decision | Reason |
| --- | --- | --- | --- |
| `Turn` (type) | Keep | Keep | Backbone concept. |
| `TurnEvent` | Keep | Keep | Clear. |
| `TurnEvent.TurnComplete` | Keep | Keep | Reads well as terminal event. |
| `Turn.functionCalls(turn)` | `Turn.toolCalls(turn)` | Rename | Same "wire vocabulary leaking" issue as `FunctionCall`. The function returns `Items.FunctionCall[]`, which we're already aliasing as `ToolCall[]`. |
| `Turn.assistantText` / `assistantTexts` | Keep | Keep | Singular/plural pair is idiomatic. |
| `Turn.isTurnComplete` | Keep | Keep | Predicate is fine. |
| `Turn.textDeltas(stream)` | Keep | Keep | Clear stream op. |
| `Turn.appendTurn(state, turn, items?)` | `Turn.commitTurn(state, turn, items?)` or `Turn.advanceHistory(...)` | Rename (Optional) | `appendTurn` reads "append a turn", but the third argument (tool outputs) is invisible in the name. Two candidates: `commitTurn` (snapshot intent: "commit this turn plus its outputs into state") or `advanceHistory` (state intent). Either is better than `appendTurn`. I'd pick **`commitTurn`** — it reads naturally and the tool-output items are clearly part of "committing" the turn. The old name stays as alias. |
| `Turn.toStructured(turn, format)` | Keep (or `Turn.decodeStructured`) | Optional | Minor improvement. `to*` is consistent with `toToolCallOutput` etc., so I'd leave it. |

### `Resolvers` (approval planning)

| Current | Proposed | Decision | Reason |
| --- | --- | --- | --- |
| Module `Resolvers` | Module `Approval` | Rename | Both functions exist solely to gate tool calls behind approval. `Resolvers` is generic. `@effect-uai/core/Approval` is what readers expect from the import path. |
| `fromApprovalMap(predicate, map)(calls)` | `Approval.fromMap(predicate, map)(calls)` | Rename | Inside the renamed `Approval` module, the `Approval` prefix becomes implicit. `fromMap` reads cleanly with the module namespace. |
| `fromVerdictQueue(predicate, queue)(calls)` | `Approval.fromQueue(predicate, queue)(calls)` | Rename | Same. The "Verdict" qualifier is implicit (what else would a queue carry in this module?). |
| `Verdict` | Keep | Keep | The decision payload from the queue. |
| `ToolCallDecision` | `ApprovalDecision` | Rename | "ToolCallDecision" sounds general but only means "the verdict for one gated call after resolution". `ApprovalDecision` says exactly that. |
| `ToolCallPlan.approved/rejected` | Keep | Keep | Reads well: `plan.approved`, `plan.rejected`. |
| `fromVerdictQueue(...).announce` | `.announce` → `.approvalRequests` | Rename | `announce` is the least clear name in the approval surface. The stream contains `ApprovalRequested` events. Rename to `approvalRequests` so the destructure reads: `const { approved, decisions, approvalRequests } = ...`. |

### `LanguageModel`

| Current | Proposed | Decision | Reason |
| --- | --- | --- | --- |
| `LanguageModel` (the `Context.Service` tag) | Keep | Keep | Idiomatic Effect. |
| `LanguageModelService` (the shape) | Keep | Keep | Standard Effect dual (tag + service shape). |
| `streamTurn` | Keep | Keep | Reads naturally. |
| `turn` (the `Effect<Turn>` variant) | Keep | Keep | Noun-verb pun is fine. |
| `turnFromStream` | `collectTurn(stream)` | Optional rename | `turnFromStream(streamTurn(...))` reads odd. `collectTurn(streamTurn(...))` says "drain a TurnEvent stream and collect into a single Turn". Low priority. |
| `CommonRequest` | Keep | Keep | Internal shape. |

---

## Summary by category

**High-value renames (do these first):**
- `function_call*` → `toolCall*` (with wire schema kept) across `Items`, `Turn`, `Outcome`
- `Outcome` module → `ToolResult` module
- `Toolkit.executeAll` → `Tools.run` (with module rename), `Toolkit.continueWith` → `Tools.collectResults`
- `ToolEvent.Intermediate / Output` → `ToolEvent.Progress / Done`
- `ToolResult.Value` → `ToolResult.Ok`
- `Loop.value` → `Loop.emit`
- `Loop.nextAfter / stopAfter / stopWithAfter` → `thenNext / thenStop / thenEndWith`
- `Loop.stopWith` → `Loop.endWith`
- `Loop.Event` → `Loop.Step`
- `Resolvers` → `Approval`, `.announce` → `.approvalRequests`

**Optional renames (improve, but not load-bearing):**
- `Loop.loopFrom` → `Loop.loopOver`
- `Loop.nextAfterFold` → `Loop.foldThenNext`
- `Turn.appendTurn` → `Turn.commitTurn`
- `Tool.AnyKindTool` → `Tool.AnyTool`
- `Items.Item` → `Items.HistoryItem`
- `LanguageModel.turnFromStream` → `LanguageModel.collectTurn`

**Remove from public surface:**
- `Toolkit.make`, `Toolkit.toDescriptors` (consolidate on `Tool.toDescriptors`)
- `Loop.stopEvent` (internal helper, not used by recipes)

**Keep as-is:**
- `loop`, `next`, `stop`, `onTurnComplete`, `loopWithState`
- `Tool.make`, `Tool.streaming`, `Tool.fromEffectSchema`, `Tool.toDescriptors`
- `Turn`, `TurnEvent`, `Turn.functionCalls` → renamed to `toolCalls` but operator role unchanged; `Turn.assistantText(s)`, `Turn.textDeltas`, `Turn.isTurnComplete`
- `Items.userText / systemText / assistantText`
- `LanguageModel`, `streamTurn`, `turn`
- `ToolResult.Failure`, `denied`, `cancelled`, `executionError`
- `ToolCallPlan.approved / rejected`

---

## Before / after

The most important sentence in the library — the basic tool loop — should
read like the developer's mental model.

### 1. Basic tool loop

**Before:**

```ts
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

loop(initial, (state) =>
  Effect.gen(function* () {
    const lm = yield* LanguageModel
    return lm.streamTurn({ history: state.history, model, tools }).pipe(
      onTurnComplete((turn) =>
        Effect.sync(() => {
          const calls = Turn.functionCalls(turn)
          if (calls.length === 0) return stop

          return Toolkit.executeAll(allTools, calls).pipe(
            Toolkit.continueWith((results) =>
              Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
            ),
          )
        }),
      ),
    )
  }),
)
```

**After:**

```ts
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import { toToolCallOutput } from "@effect-uai/core/ToolResult"
import * as Tools from "@effect-uai/core/Tools"
import * as Turn from "@effect-uai/core/Turn"

loop(initial, (state) =>
  Effect.gen(function* () {
    const lm = yield* LanguageModel
    return lm.streamTurn({ history: state.history, model, tools }).pipe(
      onTurnComplete((turn) =>
        Effect.sync(() => {
          const calls = Turn.toolCalls(turn)
          if (calls.length === 0) return stop

          return Tools.run(allTools, calls).pipe(
            Tools.collectResults((results) =>
              Turn.commitTurn(state, turn, results.map(toToolCallOutput)),
            ),
          )
        }),
      ),
    )
  }),
)
```

Reading the second block out loud: *"on turn complete, get the tool
calls; if none, stop. Otherwise, run them, collect the results, commit
the turn with their outputs."* That's the agent loop sentence.

### 2. Emitting a custom event (model-escalation)

**Before:**

```ts
import { value, nextAfter } from "@effect-uai/core/Loop"

const announce = Stream.succeed(
  value<EscalationEvent>({ _tag: "tier_active", tier: label, model: tier.model }),
)

return nextAfter(
  Stream.succeed<EscalationEvent>({ _tag: "escalated", reason, question }),
  { history: current.history, tier: 1, escalation: args },
)
```

**After:**

```ts
import { emit, thenNext } from "@effect-uai/core/Loop"

const announce = Stream.succeed(
  emit<EscalationEvent>({ _tag: "tier_active", tier: label, model: tier.model }),
)

return thenNext(
  Stream.succeed<EscalationEvent>({ _tag: "escalated", reason, question }),
  { history: current.history, tier: 1, escalation: args },
)
```

`emit(event)` and `thenNext(stream, state)` read as actions, not as
internal type constructors.

### 3. Approval flow

**Before:**

```ts
import { fromVerdictQueue, type Verdict, type ToolCallDecision } from "@effect-uai/core/Resolvers"

const { approved, decisions, announce } = yield* fromVerdictQueue(isSensitive, verdicts)(calls)

const events = Stream.merge(
  announce,
  Stream.merge(
    Toolkit.executeAll(allTools, approved),
    decisions.pipe(Stream.flatMap(decisionToEvents)),
  ),
)
```

**After:**

```ts
import { fromQueue, type Verdict, type ApprovalDecision } from "@effect-uai/core/Approval"

const { approved, decisions, approvalRequests } =
  yield* fromQueue(isSensitive, verdicts)(calls)

const events = Stream.merge(
  approvalRequests,
  Stream.merge(
    Tools.run(allTools, approved),
    decisions.pipe(Stream.flatMap(decisionToEvents)),
  ),
)
```

`approvalRequests` makes the destructure self-documenting. The module
prefix `Approval.fromQueue` tells you what kind of queue it is without
the `Verdict` qualifier in the function name.

### 4. ToolEvent pattern matching

**Before:**

```ts
events.pipe(
  Stream.tap((e) =>
    Match.value(e).pipe(
      Match.tag("Intermediate", (i) => Console.log("progress", i.data)),
      Match.tag("Output", (o) => Console.log("done", o.result)),
      Match.orElse(() => Effect.void),
    ),
  ),
)
```

**After:**

```ts
events.pipe(
  Stream.tap((e) =>
    Match.value(e).pipe(
      Match.tag("Progress", (p) => Console.log("progress", p.data)),
      Match.tag("Done", (d) => Console.log("done", d.result)),
      Match.orElse(() => Effect.void),
    ),
  ),
)
```

`Progress` and `Done` describe the variant's meaning, not its position
in the sequence.

### 5. ToolResult construction & matching

**Before:**

```ts
import { rejected, executionError, isValue, isFailure } from "@effect-uai/core/Outcome"

if (isValue(result)) {
  console.log("ok", result.value)
} else {
  console.log("failed", result.kind, result.reason)
}

const synthetic = rejected(call, "unknown_tool", `No tool: ${call.name}`)
```

**After:**

```ts
import { failed, executionError, isOk, isFailure } from "@effect-uai/core/ToolResult"

if (isOk(result)) {
  console.log("ok", result.value)
} else {
  console.log("failed", result.kind, result.reason)
}

const synthetic = failed(call, "unknown_tool", `No tool: ${call.name}`)
```

`Ok` / `Failure` is the symmetric pair. `failed(...)` doesn't collide
with approval rejection (`denied`).

---

## What I would *not* change

Same backbone as the existing API:

- **`loop`, `stop`, `onTurnComplete`** — the three names every recipe
  centers on. They read well.
- **`Tool.make` / `Tool.streaming`** — the pair is clean, the
  asymmetry is informative ("streaming is the special case").
- **`Turn`, `TurnEvent`, `LanguageModel`, `streamTurn`** — these are
  the concepts; they're already in the user's vocabulary.
- **`Items.userText` / `systemText` / `assistantText`** — short,
  obvious, used painlessly across every recipe.
- **`denied` / `cancelled` / `executionError`** — precise failure
  constructors.

---

## Migration strategy

1. **Additive aliases first** (no breaks). For each renamed function:
   ```ts
   /** @deprecated use `thenNext` */
   export const nextAfter = thenNext
   ```
2. **Variant renames need a major** (or a `Data.taggedEnum` migration
   with both tags accepted). `Loop.Value → Loop.Emit`, `ToolEvent.Output
   → ToolEvent.Done`, `ToolResult.Value → ToolResult.Ok` change
   pattern-match string literals; can't be done silently.
3. **Module renames** (`Outcome → ToolResult`, `Toolkit → Tools`,
   `Resolvers → Approval`) ship as new paths; re-export from old
   paths for one minor cycle.
4. **Docs and recipes** move to new names first; old names stay
   exported and tested until the next major.

---

## Bottom line

The library doesn't need a sweeping rename — it needs to stop speaking
provider-wire vocabulary in developer-facing code (`function_call` →
`tool_call`) and stop using three near-synonyms in the same pipeline
(`Output` / `Value` / `FunctionCallOutput`).

The core recipe sentence should read:

```ts
const calls = Turn.toolCalls(turn)
if (calls.length === 0) return stop

return Tools.run(tools, calls).pipe(
  Tools.collectResults((results) =>
    Turn.commitTurn(state, turn, results.map(toToolCallOutput)),
  ),
)
```

That's the loop in plain English: **get the tool calls, run them, collect
results, commit the turn.** Everything else in this proposal serves that
sentence.
