# Plan: Tool kinds + safe composition (incorporating spike 3)

## Status (as built)

Parts 1, 2, and 3a are **landed and green** (162 core tests, all recipes typecheck).
The design that shipped differs from the original plan below in a few decided ways —
recorded here so the plan reads true:

- **`Toolkit` stayed a by-name record** (`Record<string, AnyTool>`), not a structured
  value. The record already gives O(1) dispatch and within-toolkit uniqueness; no
  `source`/`index`/`descriptors` fields are stored. This kept the change additive and
  left the executor (Part 1) untouched by Part 2.
- **`make` stayed synchronous.** Compile-time `UniqueTools` catches duplicate literal
  names; first-party name validation throws `InvalidToolName` (a programmer error).
  Only `compose` is effectful.
- **`compose` provenance is positional** (`sources: ["toolkit-0", "toolkit-1"]`), not a
  `source` label baked into every toolkit. It is compile-time-checked when names are
  statically known and runtime-checked (`DuplicateToolName`) for dynamic sources.
- **Landed:** four tool kinds + `non_local_tool`; `Toolkit.compose` / `namespace` /
  `makeNamespaced`; `Toolkit.wrap` middleware; `Tool.withRun`. Written functionally
  (Effect `Array`/`Record`/`Option`, `Match` dispatch).
- **Deferred (Part 3b):** `streamTurn` accepting a `Toolkit`. Recipes still call
  `Toolkit.descriptors(toolkit)`. This is the only provider-touching change and is not
  a spike idea.

The original plan follows unchanged for context.

---

Follow-up to [`tool-refactoring.md`](tool-refactoring.md). That plan (record `Toolkit`,
unified `run(input, emit)`, `ToolResult`/`ToolEvent` enums, `Approval`) is **landed**
in [`packages/core/src/tool/`](../packages/core/src/tool/). This plan takes the next
batch of ideas from the combined research spike
(`effect-uai-tool-research/src/spikes/03-combined`) and folds them into the live code.

The spike's verbatim names (`Toolset`, `Tool.effect`) are **not** adopted; see Decisions.
The valuable, missing-today ideas are:

1. **Tool kinds.** Today there is one executable tool. Signals and external
   interactions are faked with `run: () => Effect.succeed(...)`, and provider-hosted
   tools are smuggled in as raw descriptors. The spike gives each an honest kind.
2. **Safe composition.** Today a `Toolkit` is a bare record; merging is spread with
   silent last-wins. The spike makes composition an explicit, checked operation with
   duplicate-name provenance, namespacing, and first-party name validation.

## Decisions (locked)

- **Keep `Toolkit`** as the collection name, module
  ([`Toolkit.ts`](../packages/core/src/tool/Toolkit.ts)), and `@effect-uai/core/Toolkit`
  export path. Do **not** rename to the spike's `Toolset`.
- **Keep `Tool.make`** as the local/executable-tool constructor. Add `Tool.provider`,
  `Tool.signal`, `Tool.interaction` as the three new kinds. (The spike's `Tool.effect`
  rename is rejected: ambiguous in an Effect codebase, and it collides with the
  general "everything is an effect" reading.)
- **Adopt safe composition.** `Toolkit` becomes a structured value carrying a
  uniqueness guarantee; `compose`/`namespace` are explicit and checked. This
  reverses Option E's "plain data, spread, last-wins" call from `tool-refactoring.md`,
  on the strength of the MCP/multi-source clash cases the spike targets.
- **Keep the current schema layer.** Tools keep `ToolInputSchema` (Standard Schema +
  Standard JSON Schema), so Zod/Valibot/ArkType/Effect-Schema all keep working. Do
  **not** regress to the spike's `Schema.Schema`-only `inputSchema`.
- **Keep the current typed errors.** `decodeArgs` keeps returning
  `ToolError | ToolValidationError` with structured `issues`. Do not collapse decode
  failures into one opaque `input_validation_error` the way the spike's `decode` does.

A direct consequence of the first and third decisions: `Toolkit` keeps its name but
changes shape (bare record → structured value). This is safe — a repo sweep shows no
recipe relies on record access (`toolkit.<name>` / `...toolkit` / `Object.values`);
recipes only call `Toolkit.make` / `descriptors` / `run`. Typed per-tool member
access is dropped (signals/interactions are already held as standalone `const`
references and decoded via those, e.g. `model-escalation`'s `Tool.decodeArgs(escalate, call)`).

---

## Part 1: Tool kinds

### Problem

`escalate`, `schedule_wakeup`, and `choose_account` are modeled as executable tools
with throwaway handlers:

```ts
// recipes/model-escalation/index.ts today
export const escalate = Tool.make({
  name: "escalate",
  inputSchema: Tool.fromEffectSchema(EscalateInput),
  run: () => Effect.succeed({ escalated: true }), // never runs; intercepted in onTurnComplete
})
```

The `run` is a lie: the loop intercepts the call and the handler never executes.
Provider-hosted tools (native Google grounding, provider code-exec) have the opposite
problem — they have no local `run` at all and are passed as hand-built descriptors,
bypassing the toolkit.

### Shape

Add a `_tag` discriminant to `Tool` and three new constructors. `Tool.make` is
unchanged (it is the local kind, `_tag: "LocalTool"`).

```ts
// Tool.ts
export type LocalTool<Name, Input, Event, Output, R> = {
  readonly _tag: "LocalTool"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly run: (input: Input, emit: Emit<Event>) => Effect.Effect<Output, unknown, R>
  readonly emitBufferSize?: number
  readonly strict?: boolean
}

export type ProviderTool<Name, Input, Provider extends string, Config> = {
  readonly _tag: "ProviderTool"
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly provider: Provider
  readonly config: Config
  readonly strict?: boolean
}

export type SignalTool<Name, Input> = {
  readonly _tag: "SignalTool" /* name, description, inputSchema */
}
export type InteractionTool<Name, Input> = {
  readonly _tag: "InteractionTool" /* name, description, inputSchema */
}

export type AnyTool<R = any> =
  | LocalTool<string, any, any, any, R>
  | ProviderTool<string, any, string, any>
  | SignalTool<string, any>
  | InteractionTool<string, any>
```

Constructors: `Tool.make` (local, today's signature + `_tag`), `Tool.provider`,
`Tool.signal`, `Tool.interaction`. All four are model-visible (all render a
descriptor). Only `LocalTool` is executable.

### Semantics

- **`decodeArgs` works on every kind** (it only needs `name` + `inputSchema`). Signals
  and interactions are decode-only by design — the loop decodes and then changes
  control flow rather than executing.
- **`Toolkit.run` executes only `LocalTool`s.** A call that resolves to a
  provider/signal/interaction tool yields a new `non_local_tool` result kind (added to
  [`ToolResult.ts`](../packages/core/src/tool/ToolResult.ts)) instead of running a fake
  handler. A call resolving to nothing stays `unknown_tool`.
- **`toDescriptors` covers all kinds.** Provider tools carry `provider`/`config` for the
  provider adapter to render natively; signals/interactions render as ordinary
  function descriptors. Descriptor rendering reads `inputSchema` via the existing
  Standard JSON Schema path — unchanged.

### Interaction lifecycle

`Tool.interaction` is the one kind with a distinct loop contract: the loop decodes
the request, then **stops/pauses** waiting on an external actor, and resumes later by
appending a normal `function_call_output`. This is the `choose_account` / Telegram /
CLI-prompt pattern. It is documented as a recipe convention (decode → `stop({ _tag:
"NeedsInteraction", call, request })`), not new executor machinery.

### Recipe migration

| Recipe                   | Today                                                 | After                                                                                               |
| ------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `model-escalation`       | `escalate` = `Tool.make` with fake `run`              | `Tool.signal` + `Tool.decodeArgs` (unchanged)                                                       |
| `sleeper-agent`          | `schedule`/`trigger_deploy` mixed local + intercepted | keep `trigger_deploy` as `Tool.make` (it really runs); any pure side-channel signal → `Tool.signal` |
| `tool-call-approval`     | local tools (`send_email`)                            | unchanged (genuinely local)                                                                         |
| (new) provider grounding | hand-built descriptor                                 | `Tool.provider({ provider: "google", config })`                                                     |

`grounded-answer`'s `web_search` stays `Tool.make` — it is a real local tool backed by
a search-backend Layer, **not** a provider-hosted tool. Don't reclassify it.

---

## Part 2: structured `Toolkit` + uniqueness & composition

### Shape

`Toolkit` keeps its name but becomes a value that carries the tool tuple (for
compile-time uniqueness), the derived descriptors, an execution index of locals, and a
uniqueness/namespace guarantee:

```ts
export type Toolkit<
  Tools extends ReadonlyArray<AnyTool> = ReadonlyArray<AnyTool>,
  Guarantee = unknown,
> = {
  readonly tools: Tools
  readonly descriptors: ReadonlyArray<ToolDescriptor>
  readonly locals: ReadonlyMap<string, AnyLocalTool> // O(1) execution dispatch
  readonly guarantee?: Guarantee
  readonly source?: string
}
```

`ToolkitR` folds `R` over `Tools[number]` (only `LocalTool`s contribute `R`).

### Construction & composition (mirrors the spike, names kept local)

```ts
Toolkit.make(...tools)            // static/literal; compile-time dup-name check + first-party name validation
Toolkit.fromArray(tools, source?) // trusted dynamic source boundary (MCP, plugins)
Toolkit.compose(...toolkits)      // effectful; fails DuplicateToolName with `sources` provenance
Toolkit.namespace(prefix, kit)    // explicit `prefix__name` prefixing
Toolkit.makeNamespaced(prefix, ...tools)
```

- **Compile-time uniqueness** for literal `make` via the spike's `UniqueTools`
  recursion (duplicate name → `@ts-expect-error`-able type error).
- **Runtime `DuplicateToolName`** from `compose`, carrying `name` + `sources: [...]` so
  the error names which sources collided (`["github", "linear"]`).
- **`unknown_tool` / `non_local_tool` / `input_validation_error`** stay the graceful
  per-call failure kinds; composition is the one place that fails the whole build.

### What we deliberately do **not** port from the spike

The spike's own [`design-assessment.md`](../../effect-uai-tool-research/src/spikes/03-combined/design-assessment.md)
flags these — fix them here rather than copy them:

1. **One `compose`, runtime-checked.** Drop `composeCertified`/`composeNamespaced`
   (PROBE5: silently leaks duplicates when namespaces are runtime `string`). Keep a
   single `compose` that always runs the duplicate check. `composeStatic` may stay only
   as a documented zero-cost optimization for literal toolkits, but the default is
   `compose`.
2. **Name validation = first-party only.** Validate names authored by us (`make` /
   `makeNamespaced` for local/signal/interaction kinds). Do **not** validate
   `Tool.provider` names (the provider owns `google_search`) or `fromArray` dynamic
   names (MCP legitimately uses dots and >64 chars; sanitize at the provider adapter
   boundary instead). Default regex = the true cross-provider intersection
   `^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$` (leading letter/underscore, no dots, ≤64) so a
   first-party name never 400s on any provider, Gemini included.
3. **`fromArray` internal dedup — decide explicitly.** The spike trusts a single source.
   Add the cheap dedup check (a lone buggy MCP source used directly still 400s
   otherwise), or document the gap loudly. Recommendation: dedup with a warning, since
   it is a few lines and removes a real footgun.
4. **`__` namespace separator** with `__` banned inside a namespace (closes the
   delimiter-ambiguity hole, PROBE2).

### Performance caveat

The compile-time `DuplicateName` recursion is O(n²) (per
[`design-assessment.md`](../../effect-uai-tool-research/src/spikes/03-combined/design-assessment.md)).
Fine for hand-written toolkits; an MCP server's worth of tools should go through
`fromArray` (runtime-checked), not literal `make`, so the quadratic type never fires on
large sets. Note this in the `make` vs `fromArray` doc.

---

## Part 3: finish Option E Part C — `streamTurn` accepts a `Toolkit`

`tool-refactoring.md` Part C is **not** landed:
[`LanguageModel.streamTurn`](../packages/core/src/language-model/LanguageModel.ts#L21)
still takes `tools?: ReadonlyArray<ToolDescriptor>`, so every recipe hand-calls
`Toolkit.descriptors(toolkit)`. Close it now that descriptors include all four kinds:

```ts
readonly tools?: Toolkit | ReadonlyArray<ToolDescriptor>
// normalize once at the LanguageModel boundary:
//   Array.isArray(t) ? t : t.descriptors
```

Common case becomes `streamTurn({ history, model, tools: toolkit })`; the descriptor
array stays the escape hatch for mixing in externally-built descriptors. Providers
still receive `ToolDescriptor[]`, so provider decoupling holds.

`Toolkit.wrap` (middleware, Option E #2) and `Tool.withRun` (override/mock sugar) from
`tool-refactoring.md` are also still unlanded — fold them in here since the structured
`Toolkit` is the natural home, but they are secondary to Parts 1–2.

---

## Part 4: facade & exports

Keep the per-module namespace-import style the recipes use
(`import * as Tool`, `import * as Toolkit`). No flat `Tool`/`Toolset`/`Approval` object
facades (the spike's `as const` facades) — they fight tree-shaking and the existing
import convention. The new constructors are just additional named exports from
`Tool.ts`; `compose`/`namespace`/`fromArray` are named exports from `Toolkit.ts`.

Export-path additions in `package.json`: none (all live under the existing `./Tool` and
`./Toolkit` entrypoints).

---

## Phasing

1. **Part 1 — tool kinds.** Add `_tag` + `Tool.provider`/`signal`/`interaction`; make
   `Tool.make` set `_tag: "LocalTool"`; teach `toDescriptors`, `Toolkit.run`
   (`non_local_tool`), and `decodeArgs` about the kinds. Migrate `model-escalation`
   (and any signal in `sleeper-agent`) off fake handlers. Mechanical; no composition
   changes yet. **Ship-able on its own.**
2. **Part 2 — structured `Toolkit` + composition.** Restructure the `Toolkit` value,
   add `compose`/`namespace`/`makeNamespaced`/`DuplicateToolName`, first-party name
   validation, `fromArray` dedup. Update `make`/`descriptors`/`run` call sites
   (low blast radius). Add the `make`-vs-`fromArray` doc note.
3. **Part 3 — toolkit-accepting `streamTurn`.** Union the `tools` param, normalize at
   the `LanguageModel` boundary, drop hand-bound `descriptors` calls in recipes that
   don't mix external descriptors. Land `Toolkit.wrap` + `Tool.withRun`.
4. **Docs & skills.** Update the `effect-uai` skill recipes (`model-escalation`,
   `tool-call-approval`, `sleeper-agent`, `streaming-tool-output`) and the docs site
   tool pages to the new kinds + composition. (Verify each referenced symbol still
   exists at HEAD before writing it into docs.)

Each part is a self-contained PR; Parts 1–3 each bump the fixed-group version once when
they land (breaking shape changes to `Toolkit`/`Tool`).

## Non-goals

- **Renaming `Toolkit` → `Toolset`** or `Tool.make` → `Tool.effect`. Rejected above.
- **`Schema.Schema`-only `inputSchema`.** Keep `ToolInputSchema` (multi-library support).
- **Flat `as const` facades.** Keep namespace imports.
- **Typed per-call results.** `ToolResult.Ok.value` stays `unknown` (per
  `tool-refactoring.md`).
- **`def`/`implement` separation, Layer-as-toolkit.** Still deferred per the existing
  plan's Option E rationale; the structured `Toolkit` does not need them.
- **MCP adapter.** Its own plan; MCP tools enter via `fromArray` as local tools.

## Open questions

- **`guarantee` field — does any consumer read it?** It is compile-time bookkeeping
  today. Keep it only if `compose`/`namespace` actually dispatch on it at runtime;
  otherwise make it phantom/type-only.
- **`fromArray` dedup: hard fail or warn-and-last-wins?** Recommendation: dedup +
  log a warning (a single unwrapped source can still 400 otherwise).
- **Does `Toolkit.run` need a typed `interaction`/`signal` short-circuit**, or is the
  `non_local_tool` result + recipe-side `decodeArgs` interception enough? Lean: result
  is enough; the loop intercepts these in `onTurnComplete` before ever calling `run`.
- **Keep `composeStatic` at all**, or one `compose`? Lean: one `compose`; add
  `composeStatic` later only if a measured typecheck cost justifies it.
