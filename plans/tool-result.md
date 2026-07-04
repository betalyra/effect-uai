# Tool failures: typed errors, one envelope

## Problem

Three findings from building the browser/web-read tools:

1. **The executor discards tool errors.** `Toolkit.run` never fails its
   stream (every call must produce a `function_call_output`), so a failed
   `run` is converted to `ToolResult.Failure` at `Toolkit.ts:377` with the
   fixed string `"Tool execution failed"`. Whatever typed error the tool
   raised is thrown away at exactly the boundary whose job is translating
   outcomes to the wire.
2. **Working around (1) created a second envelope.** The interim
   `Result<string, string>` output convention for the canonical tools
   duplicated what `ToolResult.Ok/Failure` already expresses. Consumers had
   to double-match; the model saw two different failure encodings.
3. **The Tool ADT hides the error type.** `run` is typed
   `Effect<Output, unknown, R>`. Tools that fail with `AiError` or
   `BrowserError` lose that type at the ADT boundary, so nothing downstream
   (middleware, loops) can handle failures without guards or casts. An
   `unknown` error channel is also just un-Effect.

## Principles

- **Default tools are bare.** `Output` is the domain success (rendered
  text). Failures are typed domain errors on the effect channel. No
  `Result` in outputs, no new failure types.
- **One failure envelope.** `ToolResult.Failure { kind, reason }` is the
  only shape a failed call has, for the model and the app alike.
- **Recoverability is the loop's decision.** The executor always reports a
  failure result (the loop continues; the model sees it). How *readable*
  that failure is for the model is opt-in via middleware, not baked into
  the tool.

## Design

### 1. Tool ADT: add a typed error parameter

```ts
Tool<Name, Input, Event, Output, E = unknown, R = never>
// run: (input, emit) => Effect<Output, E, R>
```

- `E` sits between `Output` and `R`, matching Effect's `A, E, R` order.
- `Tool.make` infers `E` from the `run` body; call sites do not change.
- `withRun`, `execute`, `AnyTool`, `WrapTool`, `Middleware` thread it;
  `ToolkitE<T>` joins `ToolkitR<T>` as the toolkit-level error union.
- Canonical tool signatures become self-documenting:
  `webSearchTool(): Tool<string, Args, never, string, AiError, WebSearch>`.

This is load-bearing, not documentation: it is what lets a loop *catch
specific tool errors*. Without it every failure is `unknown` and the only
handling possible is string matching.

- `Tool.execute` propagates `E` unwrapped (`E | ToolError |
  ToolValidationError`), so one-shot callers `catchTag` the tool's own
  errors directly.
- The streaming path propagates `E` on the stream's error channel; see (2).

Breaking only for code that wrote out a full `Tool<...>` type with `R` in
position five. In-repo that is just the two canonical tool files; recipes
use inference throughout.

### 2. Executor: one rule, everything else propagates

A `run` that fails with a **`string`** is speaking to the model: the
executor absorbs it as `ToolResult.Failure` (kind `"tool_failed"`, reason
verbatim). **Any other failure propagates**:

```ts
Toolkit.run(toolkit, calls)
// : Stream<ToolEvent, Exclude<ToolkitE<T>, string>, ToolkitR<T>>
```

- No bespoke routing callback: which errors reach the model is decided
  *before* the executor with ordinary combinators (`Effect.mapError`,
  `catchTag`, `catchIf`) inside a middleware; which errors end the run is
  decided *after* it on the stream's typed error channel.
- No lossy projections: an unhandled tagged error is not flattened to a
  string, it arrives typed where `catchTag` works.
- Defects die instead of being masked as results (a crashing tool is a
  bug, not a tool outcome).
- Unchanged: `unknown_tool`, input validation, and non-local kinds are
  still synthesized results (those are the model's contract violations
  and must be reported back to it).

Cost, documented explicitly: if one call in a concurrent batch fails the
stream, sibling calls may go unanswered. A loop that catches and
*continues* must reconcile history first (`HistoryCheck.cancelAllPending`
exists for exactly this). A loop that treats the failure as fatal just
ends; nothing to reconcile.

### 3. Recoverability as middleware, in plain Effect

The loop opts errors into model-visibility by mapping them to `string`
before the executor sees them. Total case has sugar:

```ts
// everything model-recoverable
const kit = Toolkit.wrap(toolkit, Toolkit.describeFailures(AiError.describe))
```

Selective case is just `mapError` in a middleware, no dedicated API:

```ts
// session death ends the run (typed); everything else goes to the model
const kit = Toolkit.wrap(toolkit, (run) => (input, emit) =>
  run(input, emit).pipe(
    Effect.mapError((e) =>
      e._tag === "BrowserSessionExpired" ? e : BrowserError.describe(e),
    ),
  ))
```

`describeFailures(describe)` is only `mapError` lifted over a toolkit; it
earns its export as the one-liner for the common case.

Typing note: fully threading each tool's `E` through `Middleware` is the
stretch goal; the pragmatic v1 types the callback over the union the
caller asserts. Decide during implementation.

### 4. Canonical tools: bare minimum

- `webSearchTool`, `webReadTool`: `Output = string` (rendered), fail with
  `AiError`. Policy knobs stay on the constructor (maxResults, maxChars,
  format, render). Docs state they are simple defaults; build your own
  with `Tool.make` for anything more.
- `BrowserTool`: export **each tool individually** (`gotoTool`,
  `clickTool`, `fillTool`, `pressTool`, `scrollTool`, each
  `(session) => Tool<...>`) **plus** `browserToolkit(session)` returning a
  `Toolkit`. All fail with `BrowserError`.
- **No `browser_read_page` in core.** Rendering a page for a model
  (markdown budgets, element lists, interactive selectors) is app policy.
  The usability recipe defines its own read-page tool; core provides only
  the trusted action verbs.
- Keep: schema `annotate` descriptions (they reach the model; JSDoc does
  not), `AiError.describe` / `BrowserError.describe`, compact
  `ok (now at <url>)` action outcomes.

## Reverts from the current WIP state

- Drop the `Result<string, string>` output from all three tool modules.
- Drop `isModelActionable` splits from tool code: with propagate-by-default
  the split is expressed by the loop's middleware (map to `string` for the
  model, leave typed to end the run), not decided inside the tool.
- Recipe `outcomeOf` collapses to a single `ToolResult` match.

## Impact

| Area | Change | Risk |
| --- | --- | --- |
| `tool/Tool.ts` | ADT gains `E`; `make`/`withRun` thread it; `execute` propagates `E` | breaking for explicit `Tool<...>` annotations (none outside core) |
| `tool/Toolkit.ts` | string failures absorbed verbatim, others propagate; defects die; `describeFailures`; `ToolkitE`; `continueWithResults` threads `E` | behavior change: `run` was total, now fails on unhandled errors; loops that continue after catching must reconcile history |
| `ToolResult`, `ToolEvent`, `Approval`, `HistoryCheck` | none | none |
| `WebSearchTool` | output back to `string`; `E = AiError` | output shape changes vs 0.9 (was already changing) |
| `WebReadTool`, `BrowserTool` | new modules, bare shape | new API |
| Providers | none (they consume `ToolDescriptor` only) | none |
| Recipes | `Tool.make`/`Tool.signal` call sites unaffected (inference). `grounded-answer` adds one `describeFailures(AiError.describe)` so failed searches stay model-recoverable (and demonstrates the pattern). `browser-usability` gains recipe-local `readPageTool`, selective middleware, simpler `outcomeOf` | low |
| Docs | `tools.md`: ADT signature, middleware section, "ready-made tools are simple defaults" note; search/web-reading/browser pages mention their tool | none |
| Versioning | one changeset, minor bump of the fixed group; migration note for the `Tool` type param | pre-1.0 |

## Steps

1. Tool ADT `E` param + threading (`Tool.ts`, `Toolkit.ts` types,
   `ToolkitE`, `execute` propagation).
2. Executor: absorb string failures verbatim, propagate the rest, let
   defects die; `describeFailures` middleware sugar.
3. Revert canonical tools to bare shape; split `BrowserTool` into
   individual exports + `browserToolkit`; delete core read-page.
4. Recipe: local `readPageTool`, toolkit assembly
   (`compose(browserToolkit(session), make(readPage, finish))`),
   selective middleware (session expiry stays typed, the rest described
   for the model), single-match `outcomeOf`.
5. `grounded-answer`: add `describeFailures(AiError.describe)`.
6. Docs + changeset + typecheck + format.

## Open questions

- `describeFailures` naming (alternative: `mapFailureMessage`).
- Middleware `E` threading depth (typed union vs pragmatic).
- Does `scrollTool` make the bare-minimum cut, or is viewport scrolling
  also app policy? (Leaning: keep; it is a session verb, not a rendering
  opinion.)
- Failure `kind` for absorbed string failures: reuse `"execution_error"`
  or a distinct `"tool_failed"` so contract violations and domain
  failures stay distinguishable downstream. (Leaning: `"tool_failed"`.)
