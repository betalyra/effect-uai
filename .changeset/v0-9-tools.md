---
"@effect-uai/core": minor
---

Tool layer rework (breaking, both changes mechanical at the call site):

- **`Toolkit` is a name-indexed record.** Build it with
  `Toolkit.make(...tools)` (variadic, rejects a duplicate literal name at
  compile time) or `Toolkit.fromArray(tools)` for runtime-built sets (MCP,
  last-wins). `streamTurn`'s `tools?` and `Toolkit.run` take the toolkit
  directly and render wire descriptors at the provider boundary, so the
  `Tool.toDescriptors([...])` call at the request site is gone.
  `Toolkit.descriptors(toolkit)` still returns the `ToolDescriptor[]` if you
  want it.
- **Plain and streaming tools unify into one `Tool.make`.** `run(input, emit)`
  returns the model-facing `Output` as an `Effect` and calls `emit(event)`
  for progress; fold events into the output inside `run`. `Tool.streaming`,
  `StreamingTool`, `isStreamingTool`, `AnyStreamingTool`, `AnyPlainTool`, and
  `finalize` are removed. The `Tool` type gains an `Event` parameter:
  `Tool<Name, Input, Event, Output, R>`.
- **Honest tool kinds, discriminated by `_tag`:** `Tool.make` (local),
  `Tool.provider` (provider-hosted, rendered natively), `Tool.signal` and
  `Tool.interaction` (decode-only control tools the loop intercepts). Faked
  control tools (`run: () => Effect.succeed(...)`) become `Tool.signal` /
  `Tool.interaction`; keep `Tool.decodeArgs`, drop the fake `run`.
- **Compose toolkits from independent sources:** `Toolkit.compose(...kits)`
  fails with `DuplicateToolName` on a cross-source collision instead of
  silently overwriting; `Toolkit.namespace(prefix, kit)` /
  `Toolkit.makeNamespaced(prefix, ...tools)` prefix generic names;
  `Toolkit.wrap(middleware)` wraps every local tool's `run`.
- **Sharper failures:** input-schema validation now fails with
  `Tool.ToolValidationError` and surfaces as `ToolResult.Failure` kind
  `"input_validation_error"` (was `"execution_error"`); a non-local kind
  passed to `Toolkit.run` yields kind `"non_local_tool"`.

See [Migrating to 0.9](https://effect-uai.betalyra.com/migrations/v0-9/).
