---
"@effect-uai/core": minor
"@effect-uai/ui": minor
"@effect-uai/ai-sdk": minor
"@effect-uai/responses": minor
"@effect-uai/anthropic": minor
"@effect-uai/google": minor
"@effect-uai/chat-completions": minor
"@effect-uai/mistral": minor
"@effect-uai/openai": minor
"@effect-uai/mcp": minor
"@effect-uai/recipe-kit": minor
---

Tool output redesign: tools return typed values, including images and files.

- A tool's `run` returns an `Effect` or a `Stream` (no `emit`): every element but the last is a typed `ToolEvent.Partial`, the last is the result. Without `outputSchema` it returns a `Content.Value` (text, JSON, `Content.Image` / `Content.File`, or an array of JSON and media); with one, the schema's encoded side must be JSON.
- Errors listed in a tool's `failureSchema` reach the model as typed values; any other error fails `Toolkit.run`'s stream. Calls that never ran fail with `InputInvalid`, `OutputInvalid` or `UnknownTool`. `Toolkit.describeFailures` maps undeclared errors to `ToolFailed`, or keeps them fatal when `describe` returns `undefined`.
- History holds typed parts: `ToolCallOutput.output` is `input_text | input_json | input_image | input_file` plus `isError`. `Toolkit.output` encodes an outcome with the tool's schemas, `Toolkit.decode` reads it back. Each provider serializes once: native media parts on Responses and Anthropic (`is_error` on Anthropic), an object in Gemini's `functionResponse` with media in `parts`, and `AiError.Unsupported` for media on text-only tool messages (Chat Completions, Mistral, OpenAI Realtime). MCP images, audio and resources arrive as media.
- `Toolkit.next(toolkit, state, turn)` replaces `continueWithResults(appendToolResults(...))`; `continueWith` and `appendResults` remain as its halves. `Tool.declare` replaces `signal` / `interaction`. Removed: `ToolResult`, `Tool.execute`, `Toolkit.collectResults`, `ToolEvent.Progress` / `ApprovalRequested`.
- `Approval.decisions` defines the possible answers and groups waiting calls (`resolve`); `Approval.Default` and `Approval.Denied` cover the common case. `fromMap` and the decision helpers are removed. `HistoryCheck.cancelAllPending` returns `Cancelled` outputs ready to append.
- `@effect-uai/ui` protocol v2: `tool-partial` and `tool-result { result: Success | Failure }`, typed per tool by the contract (including each tool's `failureSchema` and the app's `failures`). `Projection.toRunEvents({ contract })` encodes, `Input` answers carry typed decisions.
- `Loop.loop` and `onTurnComplete` infer a body's outer Effect error separately from its stream's.

See the 0.19 migration page.
