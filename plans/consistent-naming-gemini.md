# Naming Consistency Proposal

Based on the review of the `effect-uai` core primitives (`Loop`, `Toolkit`, `Turn`, `Items`), here is a proposal to improve intuition and alignment with standard developer terminology. 

## Summary of Pain Points
- `Loop.Event` and `Loop.next`: "Event" is heavily overloaded (e.g., `TurnEvent`, `ToolEvent`). `next` conceptually clashes with JS Iterators (where `next()` produces values). In our loop, `next` means "advance to the next iteration with new state".
- `Loop.nextAfter`: Reads a bit clunky and obscures that it is streaming values downstream before advancing the loop state.
- `Toolkit.continueWith`: Hides the fact that it is accumulating/folding tool results before continuing the loop.
- `FunctionCall` vs `Tool`: The industry (and OpenAI) has shifted from `function_call` to `tool_calls`. Our items still use the older `FunctionCall` terminology.
- `Turn.appendTurn`: It operates on a `State` object (which has a `history` array), making its placement on `Turn` and its name somewhat tautological yet unintuitive.

## Proposed Changes Table

| Concept / Category | Current Name | Proposed Name | Rationale / Notes |
| :--- | :--- | :--- | :--- |
| **Loop Type** | `Loop.Event<A, S>` | `Loop.Step<A, S>` | "Event" overlaps with TurnEvent/ToolEvent. "Step" better reflects that it is a loop iteration control instruction. |
| **Loop Control** | `Loop.value(a)` | `Loop.emit(a)` | "emit" is standard for pushing values to a stream. |
| **Loop Control** | `Loop.next(state)` | `Loop.advance(state)` | "next" collides with JS iterators. "advance" avoids the reserved keyword `continue` and perfectly describes moving the loop forward. |
| **Loop Control** | `Loop.stop`, `stopWith`| *Keep* | Clear and standard. |
| **Loop Operator** | `Loop.nextAfter` | `Loop.streamAndAdvance` | Clearly indicates it streams the input and *then* advances the state. |
| **Loop Operator** | `Loop.stopAfter` | `Loop.streamAndStop` | Sibling to above. |
| **Loop Operator** | `Loop.nextAfterFold` | `Loop.streamAndAdvanceFold` | Consistency with above. |
| **Loop Operator** | `Loop.onTurnComplete`| *Keep* | Highly descriptive and clear. |
| **Toolkit** | `Toolkit.executeAll` | `Toolkit.execute` | Plural implies all, but "execute" is a cleaner verb for running a batch of tools. |
| **Toolkit** | `Toolkit.continueWith` | `Toolkit.collectAndAdvance` | Makes it explicit that it collects tool results into an array before building the next state and advancing. |
| **Domain Items** | `FunctionCall` | `ToolCall` | Aligns with modern LLM API terminology. |
| **Domain Items** | `FunctionCallOutput` | `ToolCallResult` | Aligns with `ToolCall` and `ToolResult`. |
| **Outcome** | `toFunctionCallOutput` | `toToolCallResult` | Function conversion for the wire boundary. |
| **Turn** | `Turn.functionCalls` | `Turn.toolCalls` | Aligns with item rename. |
| **Turn** | `Turn.appendTurn` | `Turn.appendToHistory` | Clarifies that it takes a Turn and applies it to a state's history array. |

## Before & After Code Snippets

### 1. Basic Agent Loop

**Before:**
```ts
return lm.streamTurn({ history, model: "gpt-5.4-mini", tools }).pipe(
  onTurnComplete((turn) => Effect.sync(() => {
    const calls = Turn.functionCalls(turn)
    if (calls.length === 0) {
      return nextAfter(Stream.empty, Turn.appendTurn(state, turn))
    }
    
    return Toolkit.executeAll(tools, calls).pipe(
      Toolkit.continueWith((results) =>
        Turn.appendTurn(state, turn, results.map(toFunctionCallOutput))
      )
    )
  }))
)
```

**After:**
```ts
return lm.streamTurn({ history, model: "gpt-5.4-mini", tools }).pipe(
  onTurnComplete((turn) => Effect.sync(() => {
    const calls = Turn.toolCalls(turn)
    if (calls.length === 0) {
      return streamAndAdvance(Stream.empty, Turn.appendToHistory(state, turn))
    }
    
    return Toolkit.execute(tools, calls).pipe(
      Toolkit.collectAndAdvance((results) =>
        Turn.appendToHistory(state, turn, results.map(toToolCallResult))
      )
    )
  }))
)
```

### 2. Custom Loop Body

**Before:**
```ts
import { loop, value, next, stop } from "@effect-uai/core/Loop"

loop(state, (s) => {
  if (s.done) return stop
  if (s.retry) return next({ ...s, retry: false })
  return Stream.make(value("A"), value("B"), next({ ...s, done: true }))
})
```

**After:**
```ts
import { loop, emit, advance, stop } from "@effect-uai/core/Loop"

loop(state, (s) => {
  if (s.done) return stop
  if (s.retry) return advance({ ...s, retry: false })
  return Stream.make(emit("A"), emit("B"), advance({ ...s, done: true }))
})
```
