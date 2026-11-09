# Tool output redesign: typed results, multimodal parts, typed UI

Status: implemented (phases 1 to 4 and the decisions review; open: a
multimodal recipe). Deviations found while implementing are listed under
"Changes during implementation". Follow-up: `plans/typed-pending-calls.md`. Source of truth for the design: `experiments/tool-api-spike/`
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
10. **Approval:** `ToolDecision.make({...})` (constructors, `schema`, dual `resolve` →
    groups per tag + `unanswered`), `ToolDecision.Default` (Approve, Deny { reason? }),
    `ToolDecision.Denied`. App closings are typed: `ToolOutput.success` (user-supplied
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

### `tool/ToolDecision.ts`

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

- [ ] Port `Tool.test.ts`, `Toolkit.test.ts`, `ToolDecision.test.ts` to `@effect/vitest`
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
      contract's decisions (default `ToolDecision.Default.schema`); `Input.resolve` typed.
- [ ] `Thread`, `Atoms`, `Client`: thread the new types through; tests per module.

## Phase 4: recipes, examples, docs

- [ ] Recipes (about 20 use the tool API): `tool-call-approval` (decisions, typed
      closings, `fromQueue` on `ToolDecision.make`), `streaming-tool-output` (Stream
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
- `Projection.toRunEvents`: contract required. An optional one fell back to
  `Content.Value` / `CoreError`, which failed on declared errors and closings
  and let `outputSchema` values through unencoded.
- `UiContract` encodes tool values and errors with the tool's own schemas, as
  `Toolkit.output` does (no `toCodecJson`), and a spec's `outputSchema` /
  `failureSchema` must encode to JSON. One encoding for history and the UI.
- Decisions are app code, not on the contract, the tools or the toolkit: the
  app's `ToolDecision.make` sets (or an `ToolDecision.byTool` map of them) give
  `Input.make(data, Decisions.schema)` its wire schema. See Appendix A.
- `UiContract` types a core `Tool` by its own `Output` / `Failure`.
- `@effect-uai/ai-sdk`: outputs as JSON (media as data URLs), failures as
  `tool-output-error`.
- A `Stream` tool emits every value as a `Partial` as soon as it is produced,
  then the last again as the `Output` (holding each back one value hid
  progress until the next arrived). `Effect` tools emit only the `Output`;
  `describeFailures` keeps a tool's shape.
- App closings (`ToolDecision.Denied`, `Superseded`) are declared per tool, in the
  gated tools' `failureSchema` (or via `Tool.withFailures` for tools you don't
  own), not on the contract: `UiContract.make` has no `failures`, and
  `Toolkit.output` / `next` / `decode` encode closings with no extra schema.
  `Toolkit.close(toolkit, call, error)` builds the outcome as an Effect: typed
  against the toolkit's declared failures, and checked against the call's own
  tool when it runs (`UndeclaredFailure`), so a mismatch fails where it is made,
  not later inside `next`. `Toolkit.withFailures` covers a whole toolkit.
- `Toolkit.wrap` keeps a tool's shape like `describeFailures`: the middleware
  still sees a stream, and an `Effect` tool gets the stream's last value back
  (a middleware that drops it is a defect).
- Decisions per tool, kept in app code (Appendix A):
  - `Approval` is renamed `ToolDecision` and `decisions` is `make`: an answer
    can be any decision about a tool call. (`Decision` is taken by the
    decision models, the type half of `DecisionModel`.)
  - `Decisions.resolve` checks each answer against its own schema; an answer
    it doesn't take lands in `invalid` instead of being dropped.
  - `ToolDecision.closesWith(fields, build)`: a decision that ends the call carries
    the error it builds, so `Escalate` can only end in `Escalated`.
    `ToolDecision.Default.Deny` is one (wire unchanged: `Deny { reason? }`).
  - `Toolkit.close(toolkit, "name", call, error)`: with the tool's name, the
    error is checked against that tool's `failureSchema` at compile time.
  - `ToolDecision.byTool({ tool: set }, { fallback })`: one map gives the wire
    schema, typed answers in the browser and one `resolve` on the server.
  - Rejected along the way: decisions on the tool or the toolkit. Decisions
    never reach history, so tools have no reason to know them.

## Review: decisions design (implemented)

Status: implemented (R1 to R7, docs, Appendix A). The partial-answer fix in the
examples (R1) is confirmed by reading `send`; the examples have no automated
tests.

Principle for all of them: the library offers small, explicit pieces; policy
(which calls wait, what an answer does, how the page learns about problems)
stays app code. No helper that hides the loop.

### R1. A forgotten group leaves calls without an output

`resolve` returns a group per tag, but nothing makes the app handle each one.
A call in an unhandled group is not run, not closed and not kept waiting, so
the next model call fails at the provider (unanswered `function_call`).

Decision: `resolve` also returns the answered calls as one flat list; the app
handles them with Effect's own exhaustive `Match`. A forgotten tag is a compile
error, with no new helper. The groups per tag stay for apps that prefer them.

```ts
const { answered, unanswered, invalid } = RefundDecisions.resolve(waiting, answers)
const outcomes =
  yield *
  Effect.forEach(
    answered,
    ({ call, decision }) =>
      Match.value(decision).pipe(
        Match.tagsExhaustive({
          Approve: () => runOne(call),
          Reduce: ({ amount }) => runOne(withAmount(call, amount)),
          Escalate: (d) => Toolkit.close(toolkit, "issue_refund", call, d.error),
          Deny: (d) => Toolkit.close(toolkit, "issue_refund", call, d.error),
        }),
      ),
    { concurrency: "unbounded" },
  )
```

For a closing decision the entry carries its `error` (from `closesWith`).

Also to check: the examples run the agent after a resolve that answers only
some waiting calls, while the rest have no output yet. Confirm with a test; fix
by running the agent only when nothing is left waiting, or by giving the
waiting calls a placeholder output (as the follow-up-message path does).

### R2. The same tag in two sets loses fields

`byTool.schema` is a union of every set's schema. Two sets that both define
`Approve` with different fields collapse: decoding
`{ _tag: "Approve", always: true }` with `Union([Approve {}, Approve { always }])`
yields `{ _tag: "Approve" }`, on decode and on encode (confirmed). The shorter
set's check then accepts it.

Decision: keep the design (one union schema, each set checks its own answers)
and make the conflict a compile error in `byTool`, like duplicate tool names in
`Toolkit.make`. Same tag means exactly the same decision type; rename otherwise.

```ts
ToolDecision.byTool({
  issue_refund: ToolDecision.make({ Approve: {}, ... }),
  send_email: ToolDecision.make({ Approve: { always: Schema.Boolean }, ... }),
})
// ✗ "Approve" has different fields in issue_refund and send_email
```

Exact equality, not compatibility: `Approve {}` next to
`Approve { always?: boolean }` is a conflict too (the union would drop
`always`). Identical definitions and reused variants
(`ToolDecision.Default.variants.Deny`) pass.

### R3. Which calls wait and which can be answered drift apart

The app's `needsApproval` and the `byTool` map are separate lists. A call that
waits but has no decision set can never be answered.

Decision: no new helper (an object owning gating and answers hides the loop).
Document deriving the policy from the same map:

```ts
const needsApproval = (call: ToolCall) =>
  Object.hasOwn(Decisions.tools, call.name) || isHelpdeskWrite(call)
```

### R4. A rejected answer gives the user no feedback

Decision: app code, documented. The only library change: `resolve` puts two
different answers to the same call in `invalid` (today the last one wins
silently).

Documented pattern:

```ts
const { invalid, unanswered } = resolved
// Ask again for the calls whose answer didn't fit; the page shows the cards again.
yield *
  emit({
    type: "run-interrupted",
    interrupts: [...invalid.map((i) => i.call), ...unanswered].map(toInterrupt),
  })
```

To say why it asks again, the app can send its own `data` event.

### R5. Edited arguments

Two separate problems, for a refund the approver reduced from 89 to 40:

```
history:  function_call         issue_refund { orderId: "A-1042", amount: 89 }   (the model's call)
          function_call_output  { refundId: "r_77" }                               (the tool ran with 40)
```

- **The model believes 89 was refunded**, unless the output says otherwise. It
  may tell the customer the wrong amount.
- **An invalid edit is blamed on the model.** If the approver's values fail
  `inputSchema` (say, an empty subject), the run fails with `InputInvalid`,
  which the model reads as its own mistake and retries.

Decision: app code, documented; no core helper.

```ts
// Validate the edit before running; a bad edit goes back to the approver, not to the model.
const args = yield * Tool.decodeArgs(issueRefund, call)
const edited = { ...call, arguments: JSON.stringify({ ...args, amount: decision.amount }) }
yield * Tool.decodeArgs(issueRefund, edited) // fails → treat like an invalid answer (R4)

// Tell the model, next to the output:
Items.userText(`[approver] issue_refund ${call.call_id}: amount 89 → 40`)
```

Keeping the edit only in history would not help the model: it reads the call it
made and the output, so it has to be told either way.

### R6. `Tool.declare` goes; `run` becomes optional (revised: `declare` is back, see the end)

A declared tool is structurally a tool without `run`: same name, description
and input, and the model calls it like any other. Only provider tools are a
different kind (executed by the provider, never a call the app sees). The two
uses of `declare` both fit a tool without `run`:

- **Signals** (`escalate`, `finish`): no `run`, no `outputSchema`; the loop acts
  on the call.
- **Answered elsewhere** (`ask_user`, a hand-off): no `run`, but `outputSchema`
  and `failureSchema`; the app answers with a typed value or closes with an
  error, through the same waiting flow as approvals.

```ts
const escalate = Tool.make({ name: "escalate", description, inputSchema: EscalateInput })
const askUser = Tool.make({
  name: "ask_user",
  description,
  inputSchema: Schema.Struct({ question: Schema.String }),
  outputSchema: Schema.Struct({ answer: Schema.String }),
})
```

Removed: `Tool.declare`, the `Declared` type. `wrap` and `describeFailures`
skip tools without `run`.

Handling calls to tools without `run` stays the app's job for now, not checked
by the types: the loop picks them out of `Turn.getToolCalls(turn)` before
`Toolkit.run`, as the escalation recipe does today. If one still reaches `run`,
it is closed with `UnknownTool`, with a message that says what happened
(`"escalate" has no run; the app handles its calls`). Making this a compile
error is a follow-up: `plans/typed-pending-calls.md` (typed `Pending` events,
handlers like `catchTags`, `Toolkit.next` refusing unhandled calls). The
`Toolkit.calls` sorting step considered here is dropped in its favor.

A plain helper to build a tool without `run` is not needed: the missing
attribute says it.

**Revised during implementation: `Tool.declare` is back.** The typed
pending calls spike (`experiments/tool-api-spike`) showed that the types need
to tell a tool with `run` from one without, and an optional `run` can't: both
`make` overloads returned the same type, and `withFailures` lost the
distinction. Now `Tool.make` requires `run` (`_tag: "LocalTool"`) and
`Tool.declare` has none (`_tag: "DeclaredTool"`, `Declared` type, optional
`outputSchema`). `Tool.withRun` turns a declared tool into a `Tool` (the shared
spec case), `withFailures` keeps the kind, `hasRun` / `Runnable` are gone. Two
helpers handle declared calls without the pipeline: `Toolkit.split(toolkit,
turn)` (`run`, `declared` typed per tool for an exhaustive `Match`, `invalid`)
and `Toolkit.complete` (the success side of `close`).

### Kept as is

- **`OutputInvalid`** (a value the tool's own `outputSchema` rejects: a
  refinement such as `Schema.Int`, loosely typed data, an empty `Stream`) stays
  a model-visible failure.

### R7. `outputSchema` required; "anything" reaches the browser as typed parts

`Content.Value` decides text, JSON or media by the value's shape, so in the
browser it can't tell JSON shaped like `{ _tag: "Image", source }` from an
image. History is fine (its parts carry their type).

Decision, two parts:

- **Every tool with `run` declares `outputSchema`.** The developer decides what
  the tool returns; a specific schema says where media can appear, so the
  ambiguity can't occur. `Content.Value` stays, as the explicit "anything"
  (MCP tools use it: they are only known at runtime).

  ```ts
  outputSchema: Schema.Struct({ title: Schema.String, screenshot: Content.Image })
  outputSchema: Content.Value // explicit: text, JSON or media
  ```

- **`Content.Value` values reach the browser as typed parts** (`input_text` /
  `input_json` / `input_image` / `input_file`, as in history), read back with
  `ToolOutput.value`. That closes the gap for MCP. A local change in
  `UiContract`.

Touches: `Tool.make` overloads (no `outputSchema`-less overload with `run`),
`withRun` (takes the new schema), about 20 recipe tools, the docs and the
skill. A tool without `run` (R6) keeps `outputSchema` optional.

### Moved to a follow-up

- **Every tool call handled, checked by the compiler**: `plans/typed-pending-calls.md`,
  listed in `plans/backlog.md`.

### Order

1. R2 (compile-time conflict check), R1 (`answered` plus the partial-answer
   test), R4's duplicate answers.
2. R6 (optional `run`, `Tool.declare` removed, clearer `UnknownTool` message).
3. R7 (`outputSchema` required, typed parts for `Content.Value` in the browser).
4. Docs for R3, R4, R5; update Appendix A.

## Appendix A: tool call decisions

How an app asks a person about a tool call before it runs, and how the answer
becomes the call's outcome.

### The idea

A **decision** is a person's answer to a waiting tool call: `Approve`, `Deny`,
`Edit`, whatever the app defines. Decisions are app code. Tools and toolkits
know nothing about them.

What a tool does declare is every way a call can **end**: its `outputSchema`
for success, its `failureSchema` for errors, including errors the app may close
a call with (`Denied`, `Escalated`). That is the only contract between the two,
and it is what history, the model and the UI read.

```
person answers ──► decision (app)            Approve | Reduce{amount} | Escalate{team} | Deny{reason?}
                     │ resolve: each call checked against its tool's decisions
                     ▼
app acts       ──► run the call (as is, or with edited arguments)  or  close it with an error
                     ▼
call ends      ──► Success(value) | Failure(error)     typed by the tool's schemas
                     ▼
history, model, UI: the same typed outcome
```

### The pieces

| Piece                                              | What it does                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ToolDecision.make({...})`                         | One set of answers: constructors, wire schema, `resolve` (`answered`, groups per tag, `unanswered`, `invalid`). |
| `ToolDecision.closesWith(fields, build)`           | An answer that ends the call; `build` makes its error.                                                          |
| `ToolDecision.byTool({ tool: set }, { fallback })` | Which set each tool takes; typed `answer` and one `resolve`.                                                    |
| `ToolDecision.Default` / `ToolDecision.Denied`     | Ready set: `Approve`, `Deny { reason? }` ending in `Denied`.                                                    |
| `Toolkit.close(toolkit, "tool", call, error)`      | Ends a call with an error the tool declares (checked).                                                          |
| `Tool.withFailures` / `Toolkit.withFailures`       | Declare closing errors on tools you don't define (MCP).                                                         |

### Example: a refund desk

A support agent that looks up orders, issues refunds and emails customers, plus
a helpdesk MCP server. Refunds offer `Approve`, `Reduce`, `Escalate`, `Deny`;
emails offer `Approve`, `Edit`, `Deny`; the helpdesk's write tools offer
`Approve` / `Deny`; everything else runs without asking.

**Shared by server and browser**

```ts
// Errors a refund can end with: its own, and the ones the app closes it with.
export class Escalated extends Schema.TaggedError<Escalated>()("Escalated", {
  team: Schema.Literals(["finance", "legal"]),
  message: Schema.String,
}) {}

export const IssueRefund = {
  name: "issue_refund",
  description: "Refund part or all of an order.",
  inputSchema: Schema.Struct({ orderId: Schema.String, amount: Schema.Number }),
  outputSchema: Schema.Struct({ refundId: Schema.String, amount: Schema.Number }),
  failureSchema: Schema.Union([OrderNotFound, ToolDecision.Denied, Escalated]),
} as const

// What a person may answer, per tool.
export const RefundDecisions = ToolDecision.make({
  Approve: {},
  Reduce: { amount: Schema.Number },
  Escalate: ToolDecision.closesWith(
    { team: Schema.Literals(["finance", "legal"]) },
    ({ team }) =>
      new Escalated({ team, message: `Handed to ${team}; they will contact the customer.` }),
  ),
  Deny: ToolDecision.closesWith(
    { reason: Schema.optionalKey(Schema.String) },
    ({ reason }) => new ToolDecision.Denied({ message: reason ?? "The refund was declined." }),
  ),
})

export const EmailDecisions = ToolDecision.make({
  Approve: {},
  Edit: { subject: Schema.optionalKey(Schema.String), body: Schema.optionalKey(Schema.String) },
  Deny: ToolDecision.Default.variants.Deny,
})

export const Decisions = ToolDecision.byTool(
  { issue_refund: RefundDecisions, send_email: EmailDecisions },
  { fallback: ToolDecision.Default }, // the helpdesk's write tools
)

// Which calls wait: plain app policy, derived from the same map so a call that
// waits can always be answered.
export const needsApproval = (call: ToolCall) =>
  Object.hasOwn(Decisions.tools, call.name) || /^helpdesk__(write|delete)_/.test(call.name)

// The wire: answers decode with every set's schema.
export const ChatInput = Input.make(Schema.Struct({}), Decisions.schema)
export const ChatUi = UiContract.make({ tools: [LookupOrder, IssueRefund, SendEmail] })
```

**Server: tools**

```ts
const toolkit =
  yield *
  Toolkit.compose(
    Toolkit.make(lookupOrder, issueRefund, sendEmail),
    // Dynamic MCP tools: declare the closing on them too.
    Toolkit.withFailures(yield * mcpToolkit(client, { prefix: "helpdesk" }), ToolDecision.Denied),
  )
```

The loop runs the calls that don't need approval, parks the rest and ends the
run with `run-interrupted`; the page shows a card per waiting call.

**Browser: one card per tool, typed by its decisions**

```tsx
Match.value(interrupt).pipe(
  Match.when({ name: "issue_refund" }, (i) => (
    <RefundCard
      amount={i.input.amount}
      onApprove={() => send(Decisions.answer(i, RefundDecisions.Approve()))}
      onReduce={(amount) => send(Decisions.answer(i, RefundDecisions.Reduce({ amount })))}
      onEscalate={() => send(Decisions.answer(i, RefundDecisions.Escalate({ team: "finance" })))}
    />
  )),
  // Decisions.answer(i, EmailDecisions.Edit({})) here would not compile.
  Match.orElse((i) => (
    <ApproveOrDeny
      onApprove={() => send(Decisions.answer(i, ToolDecision.Default.Approve()))}
      onDeny={(reason) => send(Decisions.answer(i, ToolDecision.Default.Deny({ reason })))}
    />
  )),
)

const send = (answer: ToolDecision.Answer<unknown>) => submit(Input.resolve([answer]))
```

**Server: the answers**

```ts
const { issue_refund, send_email, fallback, unanswered, invalid } = Decisions.resolve(
  waiting,
  input.decisions,
)

// Each tool's answered calls, tagged like their decision: a forgotten tag is a compile error.
const refunds = Effect.forEach(issue_refund.answered, (entry) =>
  Match.value(entry).pipe(
    Match.tagsExhaustive({
      Approve: ({ call }) => runOne(call),
      Reduce: ({ call, decision }) =>
        runOne(withArgs(issueRefund, call, { amount: decision.amount })),
      Escalate: ({ call, error }) => Toolkit.close(toolkit, "issue_refund", call, error),
      Deny: ({ call, error }) => Toolkit.close(toolkit, "issue_refund", call, error),
    }),
  ),
)
const emails = Effect.forEach(send_email.answered, (entry) =>
  Match.value(entry).pipe(
    Match.tagsExhaustive({
      Approve: ({ call }) => runOne(call),
      Edit: ({ call, decision }) => runOne(withArgs(sendEmail, call, decision)),
      Deny: ({ call, error }) => Toolkit.close(toolkit, "send_email", call, error),
    }),
  ),
)
// The helpdesk's tools are only known at runtime: close is checked when it runs.
const writes = Effect.forEach(fallback.answered, (entry) =>
  Match.value(entry).pipe(
    Match.tagsExhaustive({
      Approve: ({ call }) => runOne(call),
      Deny: ({ call, error }) => Toolkit.close(toolkit, call, error),
    }),
  ),
)
const outcomes = (
  yield * Effect.all([refunds, emails, writes], { concurrency: "unbounded" })
).flat()
const items = yield * Effect.forEach(outcomes, Toolkit.output(toolkit))
// unanswered and invalid calls keep waiting; the page can ask again.
```

`runOne` runs one call with `Toolkit.run`. `withArgs` merges the person's values
into the call's arguments and validates them with `Tool.decodeArgs` first, so a
bad edit goes back to the person instead of reaching the model as
`InputInvalid`.

**What ends up in history**

```ts
// Escalate: a failure the model reads and can act on
{ type: "function_call_output", call_id: "c1", isError: true,
  output: [{ type: "input_json", value: { _tag: "Escalated", team: "finance",
    message: "Handed to finance; they will contact the customer." } }] }

// Reduce: the tool ran with 40; the result says what really happened
{ type: "function_call_output", call_id: "c2",
  output: [{ type: "input_json", value: { refundId: "r_77", amount: 40 } }] }
```

The model's own `function_call` keeps its original arguments (`amount: 89`);
the output carries the effective values (or the app appends a short note). The
browser gets the same outcome typed: `Failure { error: Escalated }` or
`Success { value: { amount: 40 } }`.

### What is checked, and where

| Check                                                      | Where                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| An answer fits the call's tool (`Reduce` only for refunds) | browser: `Decisions.answer` (compile time); server: `resolve` (`invalid`) |
| Two answers to one call disagree                           | `resolve` (`invalid`)                                                     |
| The same tag means the same answer in every set            | `ToolDecision.byTool` (compile time)                                      |
| A closing decision ends in its own error                   | `closesWith`: the decision builds it                                      |
| That error is one the tool declares                        | `Toolkit.close(toolkit, "issue_refund", ...)` (compile time and runtime)  |
| Every decision is handled                                  | exhaustive `Match` over `answered` (compile time)                         |
| History, model and UI agree on the outcome                 | the tool's `outputSchema` / `failureSchema`                               |

Tools and toolkits stay free of approval: a tool only lists the ways a call
can end.
