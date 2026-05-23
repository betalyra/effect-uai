# Consistent Naming Proposal

## Scope

I reviewed the core loop/tool primitives against the docs and the recipe call sites, especially the recurring shapes in `basic-usage`, `agentic-loop`, `tool-call-approval`, `streaming-tool-output`, `auto-compaction`, `pause-resume`, `multi-model-fallback`, `mid-stream-abort`, `model-retry`, and `model-escalation`.

The API is already strongest where names describe the domain directly: `Turn`, `TurnEvent`, `Tool`, `ToolEvent`, `ToolResult`, `LanguageModel`, `streamTurn`, `onTurnComplete`, `stop`, and `Tool.toDescriptors` mostly read well in recipe code. The names that create friction are the ones that leak internal mechanics (`Value`, `next`, `nextAfterFold`) or provider wire terms (`FunctionCall`) into developer-facing tool workflows.

## Recommendation

Prefer a small set of additive aliases first, then update docs and recipes to the clearer names. The highest-value change is to align the public vocabulary around **tool calls**, **history items**, and **loop continuation**:

- A model asks for a `ToolCall`, not a `FunctionCall`.
- Tool execution produces `ToolResult`s, then those become `ToolCallOutput` history items.
- A loop body emits values and either continues or stops; developers should rarely see the internal `Value` / `Next` wording.

## Proposed Rename / Keep Table

| Current name | Proposal | Decision | Why |
| --- | --- | --- | --- |
| `Turn` | `Turn` | Keep | Clear, compact, and central to the docs. A turn is the right mental model for one provider generation. |
| `TurnEvent` | `TurnEvent` | Keep | Reads well as "events emitted during one turn." The variants are also clear. |
| `TurnEvent.TurnComplete` | `TurnEvent.TurnComplete` | Keep | Slightly noun-like, but it is visible everywhere and maps well to "terminal event carrying a Turn." |
| `Turn.functionCalls(turn)` | `Turn.toolCalls(turn)` | Rename / alias | Recipes are about tools. `function_call` is provider wire vocabulary; `toolCalls` is developer vocabulary. |
| `Turn.appendTurn(state, turn, items)` | `Turn.appendToHistory(state, turn, items)` | Rename / alias | The function mutates neither a turn nor a generic structure; it appends a completed turn plus follow-up items to `state.history`. |
| `Turn.assistantText(s)` | `Turn.assistantText(s)` | Keep | The singular/plural pair is intuitive and useful. |
| `Turn.toStructured(turn, format)` | `Turn.decodeStructured(turn, format)` | Optional rename | `toStructured` is acceptable, but `decodeStructured` better communicates validation and failure. Lower priority. |
| `Items.Item` | `Items.HistoryItem` | Rename / alias | `Item` is very generic outside the docs. `HistoryItem` makes `ReadonlyArray<Items.HistoryItem>` self-explanatory. |
| `Items.userText`, `Items.systemText`, `Items.assistantText` | Same | Keep | These constructors read naturally and are used cleanly throughout recipes. |
| `FunctionCall` | `ToolCall` | Rename / alias | The public concept is a model-requested tool call. Keep the wire `type: "function_call"` internally. |
| `FunctionCallOutput` | `ToolCallOutput` | Rename / alias | Pairs with `ToolCall`; docs can mention it serializes to provider-specific function-call output wire shapes. |
| `toFunctionCallOutput(result)` | `toToolCallOutput(result)` or `toToolCallOutputItem(result)` | Rename / alias | The current name is accurate to the wire, but obscures the tool workflow. I prefer `toToolCallOutputItem` if the return type remains a history item. |
| `Loop.loop` | `Loop.loop` | Keep | Short and appropriate inside the `Loop` module. Recipe code reads well with `pipe(initial, loop(...))`. |
| `Loop.Event` | `Loop.LoopEvent` | Rename / alias | Avoids collision with DOM/Event mental models and makes docs clearer. |
| `Loop.Value` variant | `Loop.Emit` variant | Rename / alias | "Value" is implementation language. "Emit" is what a loop body is doing. |
| `Loop.value(a)` | `Loop.emit(a)` | Rename / alias | In `model-escalation`, `value({ _tag: "tier_active" })` reads like data wrapping; `emit(...)` reads like output intent. |
| `Loop.next(state)` | `Loop.continueWith(state)` | Rename / alias | `next` is concise but internal. `continueWith(state)` reads as loop control. |
| `Loop.nextAfter(stream, state)` | `Loop.continueAfter(stream, state)` | Rename / alias | Current call sites like `nextAfter(Stream.empty, state)` are not obvious to new readers. `continueAfter` says "emit this stream, then continue." |
| `Loop.nextAfterFold(stream, initial, reduce, build)` | `Loop.continueAfterFold(...)` | Rename / alias | Same reason as `nextAfter`; it is the generalized continuation helper. |
| `Loop.stop` | `Loop.stop` | Keep | Clear and widely readable. |
| `Loop.stopAfter(stream)` | `Loop.stopAfter(stream)` | Keep | Reads well enough and mirrors `continueAfter`. |
| `Loop.stopWith(state)` | `Loop.stopWithState(state)` | Rename / alias | Makes the state-carrying behavior explicit, especially because plain `loop` treats it like `stop`. |
| `Loop.stopWithAfter(stream, state)` | `Loop.stopWithStateAfter(stream, state)` | Rename / alias | Verbose but much clearer for the uncommon state-carrying stop case. |
| `Loop.onTurnComplete(fn)` | `Loop.onTurnComplete(fn)` | Keep | The pipe form reads well: `streamTurn(...).pipe(onTurnComplete(...))`. It fixed the older `streamUntilComplete` ambiguity. |
| `Loop.loopWithState` | `Loop.loopWithState` | Keep | Accurate enough; docs should emphasize it returns a stream plus a state ref. |
| `Loop.loopFrom` | `Loop.loopEach` | Optional rename | `loopFrom` is vague. `loopEach` better suggests "for each input item, run an inner loop." Lower priority because it is not in the main recipes. |
| `Tool.make` | `Tool.make` | Keep | The namespace carries the meaning. `Tool.define` is slightly nicer, but not worth a breaking rename by itself. |
| `Tool.streaming` | `Tool.streaming` | Keep | Explicit and understandable; `Tool.stream` would be shorter but less noun-like. |
| `Tool.AnyKindTool` | `Tool.AnyTool` | Rename / alias | `AnyKindTool` is awkward. The public union of plain + streaming tools should be `AnyTool`; use `PlainTool` / `StreamingTool` for narrower cases. |
| `Tool.toDescriptors(tools)` | `Tool.toDescriptors(tools)` | Keep | Clear converter name. Prefer this as the single documented path for plain and streaming tools. |
| `Toolkit.make` | Deprecate in docs | Optional removal | A toolkit wrapper adds little at call sites and competes with plain arrays. Recipes already mostly work better with `ReadonlyArray<Tool.AnyTool>`. |
| `Toolkit.toDescriptors(toolkit)` | Prefer `Tool.toDescriptors(tools)` | Deprecate / alias | Two descriptor functions create needless choice. Keep one primary path. |
| `Toolkit.executeAll(tools, calls)` | `Toolkit.executeCalls(tools, calls)` | Rename / alias | `executeAll` omits the object. `executeCalls` says it executes model-requested tool calls. |
| `Toolkit.continueWith(build)` | `Toolkit.continueWithResults(build)` | Rename / alias | Current name is too general and collides conceptually with loop continuation. The helper specifically waits for terminal tool results before continuing. |
| `ToolEvent.Intermediate` | `ToolEvent.Update` | Rename / alias | "Intermediate" is accurate but abstract. "Update" is neutral enough for progress, sub-agent deltas, and other streamed tool events. |
| `ToolEvent.Output` | `ToolEvent.Result` | Rename / alias | The event carries a `ToolResult`; `Result` is clearer than another overloaded "output." |
| `ToolResult.Value` | `ToolResult.Success` | Rename / alias | `Value` / `Failure` is asymmetric. `Success` / `Failure` is the expected result vocabulary. |
| `Outcome` module | `ToolResult` module or keep `Outcome` as compatibility | Optional rename | `Outcome` is vague at import sites. A module named `ToolResult` would make `toToolCallOutputItem`, `denied`, `cancelled`, and `executionError` easier to discover. |
| `Resolvers.fromApprovalMap` | Same | Keep | Reads well for request/HTTP-shaped approval maps. |
| `Resolvers.fromVerdictQueue` | Same | Keep | Reads well for long-lived queue approval flows. |
| `ToolCallPlan.approved/rejected` | Same | Keep | Clear and visible in approval recipes. |
| `fromVerdictQueue(...).announce` | `approvalRequests` | Rename / alias field | `announce` is the least clear approval name. The stream contains approval-request events. |

## Before / After Sketches

### Basic Tool Loop

Before:

```ts
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"

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
```

After:

```ts
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import { toToolCallOutputItem } from "@effect-uai/core/ToolResult"

return lm.streamTurn({ history: state.history, model, tools }).pipe(
  onTurnComplete((turn) =>
    Effect.sync(() => {
      const calls = Turn.toolCalls(turn)
      if (calls.length === 0) return stop

      return Toolkit.executeCalls(allTools, calls).pipe(
        Toolkit.continueWithResults((results) =>
          Turn.appendToHistory(state, turn, results.map(toToolCallOutputItem)),
        ),
      )
    }),
  ),
)
```

This is the most important rename set. It changes the sentence from "function calls become function-call outputs via Outcome" to "tool calls execute, results become tool-call output history items."

### Long-Lived Agent Loop

Before:

```ts
const calls = Turn.functionCalls(turn)

if (calls.length === 0) {
  return nextAfter(Stream.empty, Turn.appendTurn({ history }, turn))
}

return Toolkit.executeAll(tools, calls).pipe(
  Toolkit.continueWith((results) =>
    Turn.appendTurn({ history }, turn, results.map(toFunctionCallOutput)),
  ),
)
```

After:

```ts
const calls = Turn.toolCalls(turn)

if (calls.length === 0) {
  return continueAfter(Stream.empty, Turn.appendToHistory({ history }, turn))
}

return Toolkit.executeCalls(tools, calls).pipe(
  Toolkit.continueWithResults((results) =>
    Turn.appendToHistory({ history }, turn, results.map(toToolCallOutputItem)),
  ),
)
```

`continueAfter(Stream.empty, state)` is still not beautiful, but it is more readable than `nextAfter(Stream.empty, state)`. If this shape appears often, a small helper could be worth considering:

```ts
return continueWith(Turn.appendToHistory({ history }, turn))
```

That would be a loop-level helper for "continue without emitting more values."

### Custom Events In Model Escalation

Before:

```ts
const announce = Stream.succeed(
  value<EscalationEvent>({ _tag: "tier_active", tier: label, model: tier.model }),
)

return nextAfter(
  Stream.succeed<EscalationEvent>({
    _tag: "escalated",
    reason: args.reason,
    question: args.question,
  }),
  { history: current.history, tier: 1, escalation: args },
)
```

After:

```ts
const announce = Stream.succeed(
  emit<EscalationEvent>({ _tag: "tier_active", tier: label, model: tier.model }),
)

return continueAfter(
  Stream.succeed<EscalationEvent>({
    _tag: "escalated",
    reason: args.reason,
    question: args.question,
  }),
  { history: current.history, tier: 1, escalation: args },
)
```

This is where `value` is most visibly unintuitive. `emit` describes the public loop-body operation.

### Approval Flow

Before:

```ts
const { approved, decisions, announce } = yield* fromVerdictQueue(isSensitive, verdicts)(calls)

const events = Stream.merge(
  announce,
  Stream.merge(
    Toolkit.executeAll(allTools, approved),
    decisions.pipe(Stream.flatMap(decisionEvents)),
  ),
)
```

After:

```ts
const { approved, decisions, approvalRequests } =
  yield* fromVerdictQueue(isSensitive, verdicts)(calls)

const events = Stream.merge(
  approvalRequests,
  Stream.merge(
    Toolkit.executeCalls(allTools, approved),
    decisions.pipe(Stream.flatMap(decisionEvents)),
  ),
)
```

The returned stream name matters because approval recipes are policy-heavy. `approvalRequests` is concrete; `announce` is not.

### Streaming Tools

Before:

```ts
type ToolEvent =
  | { _tag: "ApprovalRequested"; call_id: string; tool: string; arguments: unknown }
  | { _tag: "Intermediate"; call_id: string; tool: string; data: unknown }
  | { _tag: "Output"; result: ToolResult }

type ToolResult =
  | { _tag: "Value"; call_id: string; tool: string; value: unknown }
  | { _tag: "Failure"; call_id: string; tool: string; kind: string; reason?: string }
```

After:

```ts
type ToolEvent =
  | { _tag: "ApprovalRequested"; call_id: string; tool: string; arguments: unknown }
  | { _tag: "Update"; call_id: string; tool: string; data: unknown }
  | { _tag: "Result"; result: ToolResult }

type ToolResult =
  | { _tag: "Success"; call_id: string; tool: string; value: unknown }
  | { _tag: "Failure"; call_id: string; tool: string; kind: string; reason?: string }
```

This makes the event/result split easier to explain:

- `ToolEvent.Update` is what the user/UI can see while a streaming tool runs.
- `ToolEvent.Result` is terminal per call.
- `ToolResult.Success` / `Failure` is what the next model turn receives after conversion to a history item.

## Names I Would Not Change

I would avoid renaming these unless there is a larger API redesign:

- `loop`: it is short, already scoped by the `Loop` module, and all recipes center around it.
- `onTurnComplete`: it reads well in pipes and is more honest than the old `streamUntilComplete`.
- `stop` and `stopAfter`: these are clear and common.
- `Tool.make` and `Tool.streaming`: not perfect, but understandable once namespaced.
- `Turn`, `TurnEvent`, `Tool`, `ToolEvent`, `ToolResult`, `LanguageModel`, `streamTurn`: these are the backbone concepts and mostly intuitive.
- `Items.userText` / `systemText` / `assistantText`: the constructors are concise and obvious.

## Suggested Migration Strategy

1. Add aliases without removing old names:
   - `Turn.toolCalls = Turn.functionCalls`
   - `Turn.appendToHistory = Turn.appendTurn`
   - `Loop.emit = Loop.value`
   - `Loop.continueAfter = Loop.nextAfter`
   - `Loop.continueAfterFold = Loop.nextAfterFold`
   - `Toolkit.executeCalls = Toolkit.executeAll`
   - `Toolkit.continueWithResults = Toolkit.continueWith`
   - `Tool.AnyTool = Tool.AnyKindTool`

2. Update docs and recipes to use the new names in the main path.

3. Keep compatibility aliases for at least one minor cycle, with migration docs showing mechanical replacements.

4. Only consider variant renames (`ToolEvent.Intermediate` -> `Update`, `ToolResult.Value` -> `Success`, `Loop.Value` -> `Emit`) in a major version, because tagged-union variant names affect pattern matching and persisted event logs.

## Bottom Line

The API does not need a broad rename. The main improvement is to make recipe code read like the developer's mental model:

```ts
const calls = Turn.toolCalls(turn)

return Toolkit.executeCalls(tools, calls).pipe(
  Toolkit.continueWithResults((results) =>
    Turn.appendToHistory(state, turn, results.map(toToolCallOutputItem)),
  ),
)
```

That sentence is the core library loop: **tool calls execute, tool results are collected, history advances, and the loop continues.**
