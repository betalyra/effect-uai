---
"@effect-uai/core": minor
"@effect-uai/responses": minor
"@effect-uai/anthropic": minor
"@effect-uai/google": minor
"@effect-uai/jina": minor
"@effect-uai/openai": minor
"@effect-uai/elevenlabs": minor
"@effect-uai/inworld": minor
"effect-uai": minor
---

Consistent-naming sweep: the public API settles on "tool call"
terminology, two modules move to clearer names, and the `Loop` helper
surface is trimmed. Breaking but mechanical — almost every rewrite is
find-and-replace. **The wire format is unchanged** (`function_call` /
`function_call_output` still go out on the wire), so no provider
payloads change. Full before/after diffs and recommended order:
[Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).

### "Function call" → "tool call"

- `Item` → `HistoryItem`; `FunctionCall` → `ToolCall`;
  `FunctionCallOutput` → `ToolCallOutput`.
- `Items.functionCallOutput` → `Items.toolCallOutput`;
  `Items.isFunctionCall` → `Items.isToolCall`;
  `Items.isFunctionCallOutput` → `Items.isToolCallOutput`.
- `Turn.functionCalls` → `Turn.getToolCalls`;
  `Turn.appendTurn` → `Turn.appendToHistory`;
  `Turn.toStructured` → `Turn.decodeStructured`.

### Module renames

- `@effect-uai/core/Outcome` → `@effect-uai/core/ToolResult`:
  `ToolResult.Value` → `ToolResult.Ok` (`isValue` → `isOk`),
  `rejected` → `failed`, `toFunctionCallOutput` → `toToolCallOutput`.
  The `Failure` variant and `denied` / `cancelled` / `executionError`
  synthesizers are unchanged.
- `@effect-uai/core/Resolvers` → `@effect-uai/core/Approval`:
  `fromApprovalMap` → `fromMap`, `fromVerdictQueue` → `fromQueue`,
  the queue helper's `announce` field → `approvalRequests`,
  `ToolCallDecision` → `ApprovalDecision`.

### Tools

- `Toolkit.executeAll` → `Toolkit.run`;
  `Toolkit.continueWith` → `Toolkit.continueWithResults`.
- Removed `Toolkit.make` / `Toolkit.toDescriptors` — build a flat array
  of tools and render it with `Tool.toDescriptors([...])`.
- `Tool.AnyKindTool` → `Tool.AnyTool`.
- `ToolEvent.Intermediate` → `ToolEvent.Progress` (`isIntermediate` →
  `isProgress`); `Output` unchanged.

### Loop

- `loopFrom` → `loopOver`; the body's emit type `Loop.Event` →
  `Loop.Step`.
- `stop` is now a function: `stop()` ends the loop, `stop(state)`
  replaces `stopWith(state)`. `next(state)` and `stop()` are
  single-element streams — concatenate values in front of them
  (`stream.pipe(Stream.map(value), Stream.concat(next(s)))`).
- Removed `nextAfter`, `stopAfter`, `stopWithAfter`, `stopWith`,
  `stopEvent`, `nextAfterFold`.
