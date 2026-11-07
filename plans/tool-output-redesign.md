# Tool output redesign: typed results, multimodal parts, typed UI

Status: implemented (phases 1 to 4; open: a multimodal recipe). Deviations
found while implementing are listed under "Changes during implementation" at
the end. Source of truth for the design: `experiments/tool-api-spike/`
(`NOTES.md`, `TYPED-HISTORY.md`, `app/`). This plan moves it into `@effect-uai/core`,
the provider packages and `@effect-uai/ui`, plus recipes, examples and docs.

Ships as one breaking release, folded into **0.19** (unreleased; `docs/migrations/v0-19.md`
already holds the `Approval.fromQueue` move).

## Decisions (from the spike)

1. **Tool kinds:** `Tool` (has `run`) and `Declared` (no `run`; replaces `SignalTool` and
   `InteractionTool`), plus `ProviderTool` unchanged.
2. **`run` returns `Effect<Output> | Stream<Output>`.** No `emit`, no `Event` type
   parameter. Partials are `Output`-typed snapshots; the last value is the result.
3. **Errors:** a tool declares `failureSchema`; matching errors become model-visible
   failures, everything else fails the stream (typed). Core's own failures are tagged
   errors: `InputInvalid`, `OutputInvalid`, `UnknownTool`. No `kind` strings, no
   string errors.
4. **Output typing:** without `outputSchema`, `run` returns a `Content.Value`
   (`string | Json | Media | ReadonlyArray<Json | Media>`); with one, the schema's
   encoded side must be JSON (`Schema.Date` is a type error, `DateFromString` works).
   `Tool.make` uses `const Name`.
5. **Media:** `Content.Image` / `Content.File` are `Schema.TaggedClass` instances,
   recognized by class, never by shape. Everything else stays plain.
6. **`Toolkit.run` emits `ToolEvent = Partial | Output`**, typed per tool (`tool` is the
   discriminant), values decoded. `ToolResult` is removed; outcomes are Effect's `Result`.
7. **History holds typed parts, not a string.** `ToolCallOutput.output` is
   `ReadonlyArray<input_text | input_json | input_image | input_file>` plus `isError`.
   `input_json` holds a value. `Toolkit.output` is the one place that encodes
   (`outputSchema ?? Content.Value`, failures via `failureSchema ∪ RunError`);
   `Toolkit.decode` goes back.
8. **Codecs serialize once.** JSON is stringified in the Responses, Anthropic, Chat
   Completions and Mistral codecs; Gemini gets the object. Media goes to native parts;
   text-only APIs fail with `AiError.Unsupported` (never drop parts).
9. **Loop helpers:** `continueWithResults` → `Toolkit.continueWith(build)` (effectful
   `build`), `appendToolResults` → `Toolkit.appendResults(toolkit, state, turn)`, new
   `Toolkit.next(toolkit, state, turn)` = their composition. `Toolkit.output(toolkit)`
   is pipeable; `Toolkit.isOutcome` keeps per-tool types.
10. **Approval:** `Approval.decisions({...})` (constructors, `schema`, dual `resolve` →
    groups per tag + `unanswered`), `Approval.Default` (Approve, Deny { reason? }),
    `Approval.Denied`. App closings are typed: `ToolOutput.success` (user-supplied
    result) / `ToolOutput.failure` (denied, superseded).
11. **UI:** the contract carries each tool's `failureSchema`, the app's `failures` and
    `decisions`. A tool block narrowed by `name` has typed `input`, `partial` and
    `outcome` (`Success { value } | Failure { error }`). Answers are typed decisions.
12. **Typed history is deferred.** Additive later (`HistoryItem<T = never>`, lowering at
    send time); see `TYPED-HISTORY.md`. Phase 1 keeps `Toolkit.run`'s `Output` event
    shaped like the future history item so that stays additive.

## Phase 1: core domain and tool package

### `domain/Items.ts`

- [ ] Add `InputJson` (`{ type: "input_json", value: Schema.Json }`).
- [ ] Add `ToolOutputContent = InputText | InputJson | InputImage | InputFile`.
- [ ] `ToolCallOutput.output: Schema.Array(ToolOutputContent)`, add
      `isError: optionalKey(Boolean)`.
- [ ] `Items.toolCallOutput(call_id, text)` stays as a shorthand (one text part).
- [ ] Constructors: `text`, `json`, `image`, `file` for parts.

### `tool/Content.ts` (new)

- [ ] `Image`, `File` as `Schema.TaggedClass`; `Media`, `isMedia`, `image()`, `file()`.
- [ ] Their `source` uses a **JSON codec** of core's `ImageSource` / `FileSource`
      (bytes as base64), so media crosses the UI wire. Core's `ImageBytesSource`
      uses `Schema.Uint8Array` (not JSON): add the JSON variant next to it rather than
      change the existing schema.
- [ ] `Value` schema + type.

### `tool/Tool.ts`

- [ ] `Tool<Name, Input, Output, Failure, E, R>` with `inputSchema` (Effect Schema or
      Standard Schema, as today), `outputSchema?`, `failureSchema?`,
      `run: (input) => Effect | Stream`.
- [ ] `make` overloads: without `outputSchema` (`Output extends Content.Value`), with it
      (`Codec<Output, Encoded extends Json>`); `const Name`.
- [ ] `Declared` + `declare()`; remove `signal`, `interaction`, `SignalTool`,
      `InteractionTool`, `Emit`.
- [ ] Keep `ToolFailed` + `fail(message)` and `describeFailures` (opt-in "every error
      goes to the model").
- [ ] Update `withName`, `withRun`, descriptors, `decodeArgs`.
- [ ] Remove `Tool.execute`: unused outside core, and its semantics differ from
      `Toolkit.run` (every error propagates, progress dropped). The equivalent is
      `Toolkit.run(Toolkit.make(tool), [call])` + `Toolkit.output`.

### `tool/ToolOutput.ts` (new)

- [ ] `parts`, `success`, `failure`, `make`, `value`, `encoded` (as in the spike).
- [ ] Core errors: `InputInvalid`, `OutputInvalid`, `UnknownTool` (`RunError` union, what
      `Toolkit.run` produces) and `Cancelled` (what `HistoryCheck` produces). The UI
      contract always decodes all four.

### `tool/ToolEvent.ts`

- [ ] `Partial<Name, Out>` and `Output<Name, Out, E>`; drop `ApprovalRequested` and
      `Progress`.

### `tool/Toolkit.ts`

- [ ] `run` emits `Event<T>` (per-tool union + `Output<string, never, RunError>`),
      decoded values, validated against `outputSchema`; error split as in the spike.
      Keep `concurrency` and the queue-free stream executor.
- [ ] `output` (dual), `decode`, `isOutcome`, `Outcome`.
- [ ] `continueWith`, `appendResults`, `next`; remove `continueWithResults`,
      `appendToolResults` and `collectResults` (unused outside core; the explicit form is
      `Stream.filter(Toolkit.isOutcome)` + `Stream.runCollect`, optionally
      `Stream.mapEffect(Toolkit.output(toolkit))` for history items).
- [ ] Adapt `compose`, `namespace`, `makeNamespaced`, `wrap`, `describeFailures` to the
      new `Tool` type (namespaced names must keep the per-tool typing).
- [ ] Delete `tool/ToolResult.ts`.

### `tool/Approval.ts`

- [ ] `decisions`, `Default`, `Denied`, `Answer`, dual `resolve`. Remove
      `ApprovalDecision`, `approve`, `reject`, `split…`, `approvalRequested`, `fromMap`.

### `tool/HistoryCheck.ts`

- [ ] `cancelAllPending(history, reason?)` returns `ToolCallOutput`s via
      `ToolOutput.failure` with core's tagged `Cancelled { message }` (a
      `Schema.TaggedError` in `ToolOutput`, separate from `AiError.Cancelled`, which is
      a provider error). An app wanting its own error uses `findUnansweredCalls` +
      `ToolOutput.failure`. Update `findUnansweredCalls` for the new item shape.

### `domain/Turn.ts`, `domain/Realtime.ts`, `loop/Loop.ts`

- [ ] `Turn.appendToHistory` unchanged. Realtime `ToolResult { output: ToolCallOutput }`
      keeps its shape (parts now). `Loop` unchanged.

### Tests

- [ ] Port `Tool.test.ts`, `Toolkit.test.ts`, `Approval.test.ts` to `@effect/vitest`
      (`it.effect`), covering: error split, partials, `outputSchema` rejection, mixed
      media arrays, `decode` round trip, `next` / `continueWith`, typed narrowing via
      `expectTypeOf` (including `Schema.Date` rejected, `const Name`).

## Phase 2: providers

Every codec maps `ToolCallOutput.output` parts natively (sketches: spike `Codecs.ts`).

- [ ] `responses`: parts → `input_text` / `input_image` / `input_file`; JSON stringified.
- [ ] `anthropic`: `tool_result.content` text / image / document blocks; `is_error`.
- [ ] `google`: `functionResponse.response` = `{ output }` or `{ error }` (object, no
      stringify), media in `functionResponse.parts`; delete the parse-the-string
      fallback (`codec.ts:296-322`).
- [ ] `chat-completions`, `mistral`: text and JSON joined; media → `AiError.Unsupported`.
- [ ] Realtime: `openai/realtimeSession.ts` (string output: text/JSON only, media →
      `Unsupported`), `google/realtimeSession.ts` (`functionResponse`).
- [ ] `GoogleDeepResearch`, `PerplexityDeepResearch`: check their `HistoryItem` usage.
- [ ] `mcp` Toolkit: map MCP content to `Content.Value` (text → string, image →
      `Content.Image`, resource → `Content.File`, `structuredContent` → JSON); MCP
      `isError` results → a declared `McpToolFailed`. Fixes the dropped images
      (backlog: MCP rich content).
- [ ] Tool-defining packages (`browser`, `deno`, `recipe-kit`, `web-read` users):
      move from `emit` / `ToolFailed`-everywhere to `failureSchema` and streams.
- [ ] Provider tests per codec: text, JSON, image, file, error flag, unsupported media.

## Phase 3: `@effect-uai/ui`

- [ ] `RunEvent`:
  - `ToolProgress { data }` → `ToolPartial { callId, name, value }` (encoded `Output`).
  - `ToolResult { output, isError }` → `ToolResult { callId, name, result }` with
    `result` = encoded `Success { value } | Failure { error }`.
  - Bump `PROTOCOL_VERSION`.
- [ ] `Projection.toRunEvents(stream, { contract, ...options })`: it now encodes
      (`Toolkit.run` emits decoded values), with each tool's `outputSchema` /
      `failureSchema` and the app's failures, all of which the contract already holds.
      `Source` = `TurnEvent | ToolEvent | ToolCallOutput`. Calls closed by the app go
      through `UiContract` helpers (`success(call, value)`, `failure(call, error)`).
      A raw `ToolCallOutput` in the source projects from its parts.
- [ ] `UiContract.make({ tools, failures?, decisions? })`: tools keep `failureSchema`;
      `resultCodec` with `F = never` default; `Payloads` carry input, output, failure.
- [ ] Tools without `outputSchema`: encoded and decoded with `Content.Value` on both
      sides (not raw JSON passthrough, which would mangle image bytes). The browser
      gets `string | Json | Content.Image | Content.File | array`: not tool-specific,
      but media arrives as `Content.Image`. Precise types need an `outputSchema`.
- [ ] `RunView.ToolBlock`: `output` / `error` / `progress` → `partial?` and `outcome?`
      (typed per tool; errors = tool failures | `RunError` | app failures). Statuses
      unchanged.
- [ ] `Input.Decision { callId, approved }` → `{ callId, decision }` typed by the
      contract's decisions (default `Approval.Default.schema`); `Input.resolve` typed.
- [ ] `Thread`, `Atoms`, `Client`: thread the new types through; tests per module.

## Phase 4: recipes, examples, docs

- [ ] Recipes (about 20 use the tool API): `tool-call-approval` (decisions, typed
      closings, `fromQueue` on `Approval.decisions`), `streaming-tool-output` (Stream
      tools), `agentic-loop`, `basic-usage`, `mcp-tools`, `realtime-voice-agent`,
      `camera-assistant`, `messenger-agent`, `sleeper-agent`, `radio-station`,
      `browser-usability`, `deep-research`, `grounded-answer`, `native-grounding`,
      `native-deep-research`, `streaming-structured-output`, `voice-loop`, `_shared`.
      Most change only `continueWithResults(appendToolResults(...))` → `Toolkit.next(...)`.
- [ ] Examples: `tanstack-start-chat`, `next-chat`, `foldkit-chat` (contract with
      `failureSchema` / `failures` / `decisions`, typed cards, `Schema.DateFromString`).
- [ ] A multimodal recipe (screenshot or chart tool returning `Content.Image`).
- [ ] Docs: `language-models/tools.md`, `loop.md`, `items-and-turns.md`, `mcp.md`,
      `realtime/index.md`, `coming-from/ai-sdk.md`, UI docs; `skills/effect-uai/SKILL.md`;
      `webpage/src/components/HeroCodePanel.astro`.
- [ ] `docs/migrations/v0-19.md`: before/after for every rename and removal; changeset.
- [ ] `plans/backlog.md`: tick typed `ToolResult`, tool outputs with media, `isError`,
      `input_file` in tool output, MCP rich content.

## Order and checks

1. Phase 1 → `pnpm --filter @effect-uai/core typecheck test`.
2. Phase 2 → per-provider typecheck and tests (rebuild core dist first).
3. Phase 3 → UI typecheck and tests.
4. Phase 4 → root `pnpm typecheck`, `pnpm test`, recipes' tests, examples build, docs build.

Each phase ends green before the next starts; nothing is committed by me.

## Resolved questions

- `collectResults`: removed (two explicit lines replace it).
- `Cancelled`: a core tagged error, produced by `HistoryCheck.cancelAllPending`.
- `Projection`: takes the contract.
- Tools without `outputSchema` on the UI wire: `Content.Value` on both sides.
- `Tool.execute`: removed.

## Changes during implementation

- `ToolOutput.CoreError` (`RunError` plus `Cancelled`): what `Toolkit.output` /
  `decode` and the UI always encode and decode.
- A string inside a mixed array becomes an `input_text` part, like a top-level
  string (MCP surfaced it: models saw quoted JSON strings).
- If an `outputSchema` reshapes an array with media, its JSON is kept whole as
  one part instead of dropping elements.
- `describeFailures`: `describe` may return `undefined` to keep an error fatal
  (browser-usability: stale click to the model, dead session ends the run).
- `Toolkit.isOutcome` / `continueWith` accept any tagged stream (loops carry
  their own events); `Output` is reserved.
- `Loop.loop` / `onTurnComplete`: the body's outer Effect infers error and
  requirements separately from its stream (needed once `next` adds
  `SchemaError`, and for helpers generic over a toolkit).
- `Projection.toRunEvents`: contract optional (default `Content.Value`).
- Decisions live on `Input.make(data, decisions)`, not on the contract.
- `UiContract` types a core `Tool` by its own `Output` / `Failure`.
- `@effect-uai/ai-sdk`: outputs as JSON (media as data URLs), failures as
  `tool-output-error`.
