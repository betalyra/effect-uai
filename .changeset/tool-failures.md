---
"@effect-uai/core": minor
---

Tool failures: typed error channel, one failure envelope.

- `Tool` gains a typed error parameter (`Tool<Name, Input, Event, Output, E, R>`), inferred by `Tool.make` from `run`. `Tool.fail(message, { kind? })` and the `ToolFailed` sentinel let a tool speak a failure to the model deliberately.
- `Toolkit.run` absorbs `string` / `ToolFailed` failures into `ToolResult.Failure` (the model reads and adapts to them) and propagates every other tool error typed on its stream (`Exclude<ToolkitE<T>, string | ToolFailed>`); defects die. `Toolkit.describeFailures(describe)` opts a toolkit's failures into model visibility by mapping them to strings.
- Input decoding is shared and hardened: empty arguments normalize to `{}`, a throwing validator is captured, unparseable or invalid arguments come back as an `input_validation_error` result carrying the issue detail, and tool lookup is own-property only.
- Wire format: successful string outputs pass through raw; failures render as `{"error":{"kind","message"}}`; a `run` returning nothing serializes to `"null"`.
- Canonical tools are bare: `webSearchTool` / `webReadTool` return the rendered string and fail with `AiError`; the browser module exports individual verb constructors (`gotoTool`, `clickTool`, `fillTool`, `pressTool`, `scrollTool`) plus `browserToolkit`, and page rendering (`browser_read_page`) moves into the usability recipe.
- `Approval.fromQueue` takes an optional `timeout` (unanswered gated calls resolve as `cancelled`) and its router retires once a round is fully resolved instead of running forever.

Breaking: code that wrote out a full `Tool<...>` type annotation must add the `E` parameter before `R`; `browserTools(session)` becomes `browserToolkit(session)` (or the individual verb constructors); tool outputs are no longer wrapped in `Result`.
