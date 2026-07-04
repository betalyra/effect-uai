# Tool module hardening: positions, one amendment, and the remaining executor fixes

## Scope and relationship to tool-result.md

`plans/tool-result.md` is the authoritative design for typed tool errors
(the `E` param on the Tool ADT, propagate-by-default, string absorption,
`describeFailures`). This plan does three things on top of it:

1. Records the position on the two open design questions (default tools
   in core; failure-channel semantics) with the reasoning, so the
   decision survives the discussion that produced it.
2. Amends the absorption rule with a tagged sentinel (`ToolFailed`)
   alongside bare `string`.
3. Folds the remaining findings from the tool-module review (executor
   robustness, serialization, approval lifecycle, decode parity) into
   the same implementation pass, since they touch the same lines.

---

## Position 1: ship default tool/toolkit implementations in core. Agree.

The decision to provide `webSearchTool` / `webReadTool` / browser tools
as core defaults (rather than recipe-only) is right, for these reasons:

- **The stable model-facing contract is library value, not app policy.**
  `webSearchTool()`'s descriptor is identical whichever provider Layer
  answers; swap `PerplexitySearch.layer` for `ExaSearch.layer` and the
  model sees the same tool. That swap-the-layer property is exactly what
  the capability-tag architecture exists for. A recipe cannot promise
  it; recipe code gets copy-pasted and drifts.
- **The five-minute path matters.** `Toolkit.make(webSearchTool(),
webReadTool())` plus one provider Layer is a complete agent tool
  setup. Withholding that to preserve purity would cost adoption for no
  design win.
- **The escape hatch is genuinely cheap.** Tools are plain records;
  `Tool.make` over the same `search` / `read` / session verbs is the
  documented custom path, and every default's docstring already says
  "simple default, build your own for more". Nobody is locked in.
- **The "users want different subsets" concern is solved by shape, not
  by withholding defaults.** Per tool-result.md: browser exports each
  verb constructor individually (`gotoTool`, `clickTool`, ...) plus a
  `browserToolkit(session)` bundle. Dropping a tool is record
  destructuring or composing individual constructors. No `Toolkit.pick`
  / `omit` API: a helper would save one line over destructuring and is
  not worth the surface.

Guardrail that keeps the defaults defensible (and this plan endorses
the tool-result.md split): a core default is **stable verbs + typed
errors + a narrow model-facing schema + a simple overridable render**.
Anything that bundles several rendering policies at once (markdown
budgets, interactive-element listing, the `@ref` protocol) is app
policy and stays in the recipe. So `webSearchTool` / `webReadTool` keep
their `render` option and default renders; `browser_read_page` moves
out of core.

One consequence to handle explicitly: `ClickArgs` / `FillArgs`
descriptions currently say "An @ref from browser_read_page". Once
read-page is recipe-local, core must not reference a tool it does not
ship. Reword to "A CSS selector, or an element @ref if a page-reading
tool provides one", or give the browser constructors a description
override option. Decide during implementation; rewording is the lighter
touch.

## Position 2: failures on the error channel, no auto-recovery. Agree, with one amendment.

The decision (tool `run` fails through its typed error channel; the
executor does not auto-lift failures into model-visible results; a
helper makes opt-in one line) is right:

- **The `Result<string, string>` output was a second envelope.**
  `ToolResult.Ok/Failure` already is the failure envelope; the interim
  convention forced double-matching and showed the model two encodings.
  Reverting it is correct.
- **The typed `E` is load-bearing.** `Effect<Output, unknown, R>` made
  every downstream handler a guard-and-cast; with `E` threaded, a loop
  can `catchTag("BrowserSessionExpired", ...)` and mean it.
- **No auto-recovery by default is the safe default for three
  reasons.** (1) Leak control: error messages carry internals (paths,
  hostnames, key names); putting them into model context is publishing
  them, and that must be opt-in. (2) It is the Effect idiom: typed
  failures are the caller's decision, not silently stringified.
  (3) The opt-in is one line (`Toolkit.wrap(kit,
describeFailures(AiError.describe))`), so safety costs almost
  nothing.
- **`describeFailures` is the right name** (better than
  `mapFailureMessage`): it says what happens to failures and pairs
  naturally with the existing `AiError.describe` /
  `BrowserError.describe`.

### Scoping recoverability per tool / per group

Selective recovery (e.g. web search auto-recoverable by the model,
browser failures kept typed) needs no new API; it falls out of wrap
being toolkit-scoped and toolkits being composable. The recommended
pattern is "group tools by recovery policy, wrap each group, compose":

```ts
const searchKit = Toolkit.wrap(
  Toolkit.make(webSearchTool(), webReadTool()),
  Toolkit.describeFailures(AiError.describe), // E: AiError -> string
)
const kit = yield * Toolkit.compose(searchKit, browserToolkit(session))
// ToolkitE<kit> = string | BrowserError
// Toolkit.run(kit, calls): Stream<ToolEvent, BrowserError, ...>
```

Search failures are absorbed as model-visible results; browser failures
propagate typed. Finer granularities are also expressible: per-tool via
the middleware's `name` argument (types the toolkit's `E` uniformly,
see the middleware-threading open question in tool-result.md), and
per-error-class via selective `mapError` inside one middleware
(tool-result.md's browser example). Docs show the group-then-compose
form as the primary pattern; F8 pins it with a type-level test
(`ToolkitE` of a mixed composed kit).

### Amendment: absorb a tagged sentinel alongside bare `string`

tool-result.md's rule is "a `run` that fails with a `string` is
speaking to the model". Keep it (it is the decided ergonomic and the
cheapest possible opt-in), but make the _canonical_ sentinel a tagged
error, with `string` as sugar:

```ts
// Tool.ts
export class ToolFailed extends Schema.TaggedErrorClass<ToolFailed>(
  "@betalyra/effect-uai/ToolFailed",
)("ToolFailed", {
  message: Schema.String,
  kind: Schema.optional(Schema.String), // Failure.kind override
}) {}

export const fail = (message: string, options?: { kind?: string }) =>
  new ToolFailed({ message, ...options })
```

Executor absorption becomes `typeof e === "string" || isToolFailed(e)`,
and the stream type `Exclude<ToolkitE<T>, string | ToolFailed>`.

Why the sentinel earns its place:

- Bare-string failure is the least idiomatic Effect error, and the
  magic rule makes exactly that type special. A helper effect deep in a
  tool that happens to fail with a string (quick scripts do) is
  silently forwarded to the model. `ToolFailed` is deliberate and
  greppable.
- It carries structure: the optional `kind` answers tool-result.md's
  open question. Absorbed failures get `Failure { kind: e.kind ??
"tool_failed", reason: e.message }`, so string failures and
  `Tool.fail(msg)` land identically, and a tool that wants a
  distinguishable kind (`"not_found"`, `"rate_limited"`) has a channel
  for it without new ToolResult variants.
- `describeFailures(describe)` maps to `string`; unchanged.

---

## Executor and module fixes (from the review)

Findings from the module review, harmonized with the tool-result.md
design. F1/F2 land in the same executor rewrite as tool-result.md step
2; the rest are independent.

### F1. Contract violations must carry detail back to the model

Today `validationError(call)` at `Toolkit.ts:355` drops the Standard
Schema issues that are in scope on the line above, and JSON-parse
failures fall through the `Stream.catchCause` backstop
(`Toolkit.ts:387`) into a generic `execution_error` with the fixed
string "Tool execution failed". The `"json_parse_error"` /
`"validation_threw"` tags are constructed and then erased.

Fix (these stay synthesized results, never stream failures; they are
the model's contract violations and must be reported back to it):

- Validation failure: render issues into the reason, capped:
  `issues.map((i) => `${path(i)}: ${i.message}`).join("; ")` truncated
  at ~500 chars. Kind stays `input_validation_error`.
- Unparseable `arguments`: report as `input_validation_error` with
  reason "arguments are not valid JSON" (a parse failure is the model's
  contract violation, not a tool execution error).
- A validator that throws: `input_validation_error`, reason "input
  schema validation threw", so a broken third-party schema is visible.
- Delete the outer `Stream.catchCause` backstop entirely. Each pre-run
  failure gets an explicit synthesized result at its site; anything
  else before the fork is a defect and dies (tool-result.md principle).

### F2. Post-run outcome routing replaces the two `catchCause`s

The `Fiber.join` handling becomes exit-based routing:

- Success: `Ok`.
- Failure with `string | ToolFailed`: absorbed as `Failure` (kind
  `tool_failed` or the sentinel's `kind`, reason verbatim).
- Any other typed failure: fail the stream, typed
  (`Exclude<ToolkitE<T>, string | ToolFailed>`).
- Defect: dies.
- **Interruption: propagates; never synthesize a result from it.**
  Today `Effect.catchCause` converts a pure interrupt into a bogus
  "Tool execution failed" Output. That was a latent wart; with
  propagate-by-default it becomes load-bearing, because a failing call
  in a concurrent batch now interrupts its siblings, and those siblings
  must produce _no_ result rather than a fake `execution_error`. The
  loop reconciles unanswered calls via `HistoryCheck.cancelAllPending`
  (already documented in tool-result.md).

Implementation sketch: `Effect.matchCauseEffect` on the join (or await
the fiber's exit) with explicit interrupt / defect / absorbed /
propagated arms.

### F3. Safe wire serialization

`JSON.stringify(undefined)` returns the value `undefined`, not a
string. A tool with `run: () => Effect.void` (completely natural
fire-and-forget code) therefore produces a `ToolCallOutput` whose
`output` is not a string, and the provider 400s a turn later, far from
the cause. `BigInt` and circular values make `JSON.stringify` throw
synchronously inside `toToolCallOutput`, which runs in a plain `.map`
in `appendToolResults`, surfacing as a defect at the history-append
site.

Fix: one internal `safeStringify` in `ToolResult.ts`:
`JSON.stringify(v) ?? "null"`, wrapped in try/catch. On throw,
`toToolCallOutput` degrades to a `serialization_error` failure body;
`Tool.execute` (which has a typed error channel) fails with `ToolError`
instead. Applied in both `toToolCallOutput` and `Tool.execute`.

### F3b. Wire format: bare success, one distinctive failure object

Decision on what the model sees in `function_call_output`, settled here
because F3 rewrites the same function:

- **Success stays bare; no `{tag: "Success"}` envelope.** The canonical
  tools render plain text _because_ models read it best; an envelope
  would JSON-escape every rendered page and list (newlines become
  `\n`), degrading exactly what the render functions optimize, and
  taxes every successful call to disambiguate the rare failing one.
  Ecosystem convention agrees: Anthropic `is_error` and MCP `isError`
  are flags on plain content; no protocol tags the success arm.
- **String outputs pass through raw.** Today `JSON.stringify` quotes
  and escapes success strings (`"1. Effect docs\n..."`). Change:
  `typeof value === "string" ? value : safeStringify(value)`.
- **Failure is a single, distinctive shape:**
  `{"error": {"kind": "<kind>", "message": "<reason>"}}`. Nesting under
  `"error"` makes it structurally unmistakable (a raw-text success can
  never collide; a structured success would need a top-level `error`
  object with exactly these fields). With the `ToolFailed` sentinel the
  model-facing kind is authored at the tool:
  `Tool.fail("page /product/123 not found", { kind: "not_found" })`
  arrives as
  `{"error":{"kind":"not_found","message":"page /product/123 not found"}}`.
- Optional, later: thread `isFailure` on `ToolCallOutput` so the
  Anthropic adapter can additionally set native `is_error: true`. Not
  in this pass; body-level encoding works everywhere including OpenAI,
  which has no native flag.

### F4. `Approval.fromQueue` router lifecycle

The router fiber (`Approval.ts:86-94`) runs `Effect.forever` consuming
the shared verdict queue until its scope closes, and silently discards
verdicts whose `call_id` is not in its batch. With a realistic
session-long scope (one WebSocket verdict queue, one approval round per
turn), round N's still-alive router races round N+1's router for takes:
a verdict can be consumed by the wrong router and dropped, leaving the
matching `Deferred` hung forever.

Fix, minimum viable:

- Router terminates when all of its batch's deferreds are resolved
  (track outstanding count; exit at zero) instead of running forever.
  This removes the accumulation of racing routers.
- Document that the verdict queue is a single-consumer transport: the
  clean multi-round setups are either one queue per approval round, or
  a PubSub upstream when rounds can overlap. (Whether `fromQueue` grows
  a PubSub-accepting sibling: decide during implementation; do not
  build it speculatively.)
- Add an optional timeout: `fromQueue(predicate, verdicts,
{ timeout? })`. On expiry, resolve every outstanding deferred as
  `cancelled(call, "approval timed out")`. Without it the only recovery
  from a lost verdict is external interruption; `HistoryCheck` covers
  crash recovery but not a live hang.

### F5. `decodeArgs` parity for throwing validators

`decodeArgs` wraps `validate` in bare `Effect.promise`
(`Tool.ts:304-306`), so a Standard Schema whose `validate` throws
synchronously is a fiber-killing defect there, while the same schema is
a handled failure in `runTool`. `decodeArgs` is exactly what recipes
call inside `onTurnComplete` to intercept signal/interaction tools, so
a misbehaving schema library crashes the loop. Use `Effect.tryPromise`
mapping to `ToolError` ("input schema validation threw").

### F6. One shared argument decoder, plus empty-string normalization

`runTool` and `decodeArgs` currently duplicate the parse-then-validate
sequence with different bugs (F1 vs F5). Extract one internal
`decodeCallInput(tool, call)` used by both, so behavior cannot drift.
Inside it, normalize `call.arguments.trim() === "" ? "{}" :
call.arguments` before parsing: several providers/models emit `""` for
zero-arg tools, and today that is a JSON parse failure every adapter
has to remember to paper over.

### F7. Own-property tool lookup

`toolkit[call.name]` (`Toolkit.ts:329`) walks the prototype chain. A
hallucinated call named `constructor` or `toString` finds a function,
misses both the `undefined` and `LocalTool` matches, and is reported
`non_local_tool` instead of `unknown_tool`. No crash, but a wrong
diagnostic, and model-controlled input should not hit prototype
lookups on principle. Guard with `Object.hasOwn` in `runOne` (or build
null-prototype records in `indexByName`; `hasOwn` is the smaller
change).

### F8. Executor test coverage

`Toolkit.test.ts` covers descriptors, R propagation, uniqueness, and
`wrap`, but not the executor's interesting paths. Add tests pinning:

- Progress events strictly before the Output for one call; bounded
  `emitBufferSize` backpressure.
- `Effect.fail("msg")` and `Tool.fail("msg", { kind })` produce
  `Failure` with the verbatim reason (and kind).
- A typed non-sentinel failure fails the stream, typed; a defect dies;
  completed siblings' Outputs already emitted are retained.
- Interrupting the consumer interrupts a running tool and synthesizes
  no result.
- Validation failure reason contains the issue path/message; `""`
  arguments run a zero-arg tool; unparseable arguments report
  `input_validation_error`.
- `unknown_tool` vs `non_local_tool` vs a call named `"constructor"`.
- A tool returning `undefined` serializes to `"null"` on the wire; a
  BigInt output degrades to `serialization_error` instead of a defect.
- `{ concurrency: 1 }` preserves call order end-to-end.
- Approval: two sequential rounds over one queue in one scope (router
  termination); the timeout path resolves outstanding calls as
  cancelled.

### F9. Doc nits

- `wrap` docstring: state composition order explicitly (the last
  `wrap` applied is outermost and runs first).
- `ToolEvent.Output` nests `call_id` inside `result` while `Progress`
  carries it top-level. Leave the shape as is (the result already
  carries both fields; flattening duplicates data) but show the
  `e.result.call_id` demux in the ToolEvent docstring so consumers do
  not trip on the asymmetry.

## Non-changes (considered, rejected)

- No `Toolkit.pick` / `omit`: records destructure; one line saved does
  not justify API surface.
- No catching defects into results: a crashing tool is a bug, not a
  tool outcome (tool-result.md principle).
- Keep `"unbounded"` as the default `concurrency`: provider-issued
  parallel calls are semantically parallel. Order-dependent toolkits
  (browser) document `{ concurrency: 1 }`, as `browserToolkit` already
  does.
- Keep the `ToolkitR` / `ToolkitE` wide-toolkit guard (`never` for
  `fromArray` toolkits): dynamic tools carry their context in closures;
  the docstring already owns the tradeoff.

## Sequencing

Phases A and D correspond to tool-result.md's steps; B, C are
independent and can land in any order after A.

- **A. Typed errors + executor rewrite** (tool-result.md steps 1-2,
  amended): `E` param and threading; `ToolFailed` sentinel +
  `Tool.fail`; shared `decodeCallInput` (F6) with contract-violation
  detail (F1) and `hasOwn` lookup (F7); exit-based outcome routing with
  interrupt propagation (F2); delete the catch-all backstop;
  `describeFailures`; `ToolkitE`; `continueWithResults` threads `E`.
- **B. Wire serialization** (F3): `safeStringify` in `toToolCallOutput`
  and `Tool.execute`.
- **C. Approval lifecycle** (F4): router termination, timeout option,
  transport docs. Also F5 (`decodeArgs` tryPromise) if not already
  subsumed by F6 in phase A.
- **D. Canonical tools** (tool-result.md steps 3-5): revert `Result`
  outputs; split browser into individual constructors +
  `browserToolkit`; move read-page to the recipe; reword `ClickArgs` /
  `FillArgs` descriptions; recipe middleware; `grounded-answer` gains
  `describeFailures(AiError.describe)`.
- **E. Tests, docs, changeset** (F8, F9): executor + approval tests;
  `tools.md` sections (ADT signature, sentinel + `describeFailures`,
  "defaults are simple starting points", history reconciliation on
  stream failure); one changeset, minor bump of the fixed group.

## Open questions

- Sentinel naming: `ToolFailed` vs `ToolFailure` (the type name should
  not read like the `ToolResult.Failure` variant; leaning `ToolFailed`
  for that reason).
- Does bare-`string` absorption stay long-term, or does it deprecate in
  favor of `Tool.fail` once the sentinel exists? (Leaning: keep both;
  string is harmless sugar once documented as equivalent.)
- `fromQueue` multi-round transport: per-round queue as the documented
  contract, or a PubSub-accepting variant. (Leaning: document
  per-round; build nothing until a recipe needs overlap.)
- Approval timeout default: none (explicit opt-in) vs an opinionated
  default. (Leaning: none; a silent default timeout is a footgun for
  genuinely slow human approvals.)
