# Plan: Tool refactoring (Toolkit type + streaming tools)

Three breaking changes to the tool layer, landing together as one version bump:

1. **Record `Toolkit`.** Replace `ReadonlyArray<AnyTool>` with a name-indexed
   `Toolkit` value that owns its rendered descriptors.
2. **Unified `run` with `emit`.** Replace the streaming tool's `run` + `finalize`
   pair with a single `run(input, emit) => Effect<Output>`, collapsing plain and
   streaming tools into one shape.
3. **Composability on plain data (Option E).** `streamTurn` accepts the toolkit
   directly, middleware is a `Toolkit -> Toolkit` transform (`Toolkit.wrap`), and
   override / mock are native record spread. No registry, no Layer-as-toolkit.

## Design decisions

- **Input schema stays, no output schema.** Input is the one wire boundary (the
  LLM returns `arguments` as an untyped JSON string), so it is parsed and
  validated locally and is the only schema providers consume. A `run` produces its
  result in TypeScript, so its type already guarantees the shape; output
  validation only makes sense at a real runtime boundary (an external/MCP call
  inside `run`), where it lives, not as a static `Tool` field.
- **Tools stay bundled:** `Tool.make({ ..., run })`. Definition and execution are
  one object. (Separating them is deferred, see below; if added it is an additive
  constructor producing the same `Toolkit` value.)
- **`emit` is `(e) => Effect<void>`** for backpressure.
- **A `Toolkit` is plain data, not a Context service.** Handler `R` is surfaced in
  `run`'s type and provided with a `Layer` at the recipe boundary, as today.
  Composition (merge / rename / override / mock) is native record/array work;
  middleware is the one combinator (`Toolkit.wrap`) because it must track the
  middleware's `R2` in the type.
- **`streamTurn` accepts the toolkit.** `tools?: Toolkit | ReadonlyArray<ToolDescriptor>`,
  normalized once at the `LanguageModel` boundary. The toolkit is the common case;
  the descriptor array is the escape hatch for mixing provider-hosted tools.
- **Provider-hosted tools are descriptor-only.** They have a descriptor but no
  local `run`, so they never enter a `Toolkit` and never reach `Toolkit.run` (the
  provider executes them). Mixing them is a descriptor concat:
  `[...Toolkit.descriptors(kit), hostedWebSearch]`.
- **Keep `ToolValidationError` (input phase) + a `validationError` result kind.**

## Part A: record `Toolkit`

### Problem

`Toolkit.run(tools: ReadonlyArray<AnyTool>, calls)` dispatches with
`tools.find((t) => t.name === call.name)` (O(n) per call), lets two tools share a
name (first match silently wins), erases every tool to `Tool<string, any, any>`,
and makes every recipe render descriptors by hand with `Tool.toDescriptors([...])`.

### Shape

A toolkit is just the name-indexed record of tools. No wrapper: the only config
that ever lived on it (`emitBufferSize`) belongs on the tool (it is per-tool
backpressure, see Part B), and descriptors are derived, not stored (a stored field
would duplicate `tools` and go stale under native composition).

```ts
type ToolMap = Record<string, AnyTool>

export type Toolkit<Tools extends ToolMap = ToolMap> = Tools

// Index the tools by their literal `name`; throw on a duplicate name.
export const make: <const Tools extends ReadonlyArray<AnyTool>>(
  ...tools: Tools
) => Toolkit<{ [T in Tools[number] as T["name"]]: T }>

// Same, from a dynamically-built array (MCP tools discovered at runtime, etc.).
export const fromArray: (tools: ReadonlyArray<AnyTool>) => Toolkit

// Render the provider-facing descriptors on demand.
export const descriptors: (toolkit: Toolkit) => ReadonlyArray<ToolDescriptor>
//   = (tk) => Tool.toDescriptors(Object.values(tk))
```

Usage: `Toolkit.descriptors(toolkit)` to the model (bind once and reuse),
`toolkit.<name>` for typed decode/routing, `Toolkit.run(toolkit, calls)` to
execute. `ToolDescriptor` stays the provider-facing wire form, so providers never
depend on the tool layer.

What this buys: O(1) dispatch (`toolkit[call.name]`), name-uniqueness (`make`
throws on a duplicate), and type preservation (each tool keeps its `Input`/`Output`,
so `toolkit.escalate` is typed and `decodeArgs(toolkit.escalate, call)` needs no
cast).

### Composition

A tool is plain data and the toolkit keys by `tool.name`, so composing reusable
toolkits is native array/object work, not special combinators:

```ts
// merge: concat, then index
const toolkit = Toolkit.make(...weatherTools, ...emailTools)

// resolve a name clash by renaming: a tool is just an object
const toolkit = Toolkit.make(...weatherTools, { ...emailSearch, name: "email_search" })

// prefix a whole set: it's map
const prefixed = emailTools.map((t) => ({ ...t, name: `email_${t.name}` }))
const toolkit = Toolkit.make(...weatherTools, ...prefixed)
```

Changing `name` (a spread) changes the index key, since the key is derived from
`name`. The one helper worth keeping is a literal-preserving rename, because
`{ ...tool, name: "x" }` widens `name` to `string` and loses typed key access:

```ts
export const withName: <N extends string, T extends AnyTool>(tool: T, name: N) => /* T renamed to N */
```

Reach for it only when you want `toolkit.email_search` statically; otherwise hold
the renamed reference and use it directly.

### Requirements inference

`ToolKindR` folds the `R` union over the record's values instead of a tuple:

```ts
export type ToolkitR<T extends Toolkit> = T[keyof T] extends AnyTool<infer R> ? R : never

export const run: <T extends Toolkit>(
  toolkit: T,
  calls: ReadonlyArray<ToolCall>,
  options?: ExecuteOptions,
) => Stream.Stream<ToolEvent, never, ToolkitR<T>>
```

### Migration

- `run` and the approval helpers take a `Toolkit` instead of an array.
- `Tool.toDescriptors(array)` stays as the low-level renderer; `Toolkit.descriptors`
  is the thin convenience over it.
- Recipes go from `Toolkit.run(tools, calls)` + `Tool.toDescriptors(tools)` to one
  `Toolkit.make(...tools)`, then `Toolkit.descriptors(toolkit)` (bound once) /
  `Toolkit.run(toolkit, calls)`.

## Part B: one `run`, no `finalize`

### Problem

A streaming tool is two functions today (`run: (input) => Stream<Event>` plus
`finalize: (events) => Output`). Awkward to define, and because `Stream` discards
its done value, the executor accumulates _every_ event into a `Ref` just to feed
`finalize`, buffering the full event log even when the output is a running fold or
the last event.

### Shape

A tool is an `Effect` that computes `Output`; emitting progress is a side channel:

```ts
type Emit<Event> = (event: Event) => Effect.Effect<void>

type Tool<Name extends string, Input, Event, Output, R = never> = {
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly run: (input: Input, emit: Emit<Event>) => Effect.Effect<Output, unknown, R>
  readonly emitBufferSize?: number // this tool's emit-queue bound; unbounded default
  readonly strict?: boolean
}
```

This is the ergonomic dual of a `Channel` (`OutElem` = `Event`, `OutDone` =
`Output`) without exposing `Channel`. `Output` is the Effect's success, `Event`s
go through `emit`, both statically typed and distinct, no `finalize`, no forced
accumulation. ("Last element is the output" was rejected: it conflates the two
types and has no defined output for empty/errored streams.)

A plain tool never calls `emit` (so `Event` infers `never`); a streaming tool
emits progress and returns the assembled result. One constructor, one `run`
signature, no `isStreamingTool` branch. `StreamingTool`, `Tool.streaming`,
`finalize`, and `isStreamingTool` are deleted.

With the union gone, `AnyStreamingTool` / `AnyPlainTool` go too, and `AnyTool`
stops being a union: it is now just `Tool<string, any, any, any, any>` (parameterized
`AnyTool<R>` for the `ToolkitR` inference). Keep it only as a one-line readability
alias for that existential, used in `ToolMap` / `make` / `fromArray` / `withName`;
it is no longer a concept, just shorthand. (`ToolkitR` could pattern-match on
`Tool<any, any, any, any, infer R>` directly, so even the alias is optional.)

### Executor sketch

`run` yields one `Stream<ToolEvent>` per call: drain emitted events as
`ToolEvent.Progress` in real time, then one terminal `ToolEvent.Output`.

```ts
Stream.unwrapScoped(
  Effect.gen(function* () {
    const input = yield* decodeAndValidate(tool, call) // input boundary
    const queue = yield* Queue.make<Event, Cause.Done>(tool.emitBufferSize)
    const emit: Emit<Event> = (e) => Queue.offer(queue, e)
    const fiber = yield* tool.run(input, emit).pipe(Effect.ensuring(Queue.end(queue)), Effect.fork)

    const progress = Stream.fromQueue(queue).pipe(
      Stream.map((data) => ToolEvent.Progress({ call_id: call.call_id, tool: tool.name, data })),
    )
    const output = Stream.fromEffect(
      Fiber.join(fiber).pipe(
        Effect.map((value) => ToolEvent.Output({ result: okResult(call, tool.name, value) })),
        Effect.catchCause(() =>
          Effect.succeed(
            ToolEvent.Output({ result: executionError(call, "Tool execution failed") }),
          ),
        ),
      ),
    )
    return progress.pipe(Stream.concat(output)) // progress drains, then output
  }),
)
```

- `Queue<Event, Cause.Done>` + `Queue.end` (not `shutdown`) so the consumer drains
  every event before close.
- `emit` returns `Effect<void>` (`Queue.offer`), so a bounded queue gives
  backpressure. `Stream.runForEach(emit)` composes for tools that proxy an upstream
  stream.
- The bound is the per-tool `tool.emitBufferSize` (unbounded default), set on
  `Tool.make`. It is per-tool because backpressure depends on how a given tool
  emits, unlike `concurrency` (cross-tool, on `Toolkit.run`'s options).

### Consuming a `Stream` inside `run`

When a tool's work is itself a `Stream` (sub-agent tokens, upstream SSE, download
chunks), consume it inside `run` and emit each element. `emit` is
`(e) => Effect<void>`, so it drops straight into `Stream.runForEach`:

```ts
// emit-only: the stream is pure progress; the output is computed separately
run: (input, emit) =>
  Effect.gen(function* () {
    yield* source(input).pipe(Stream.runForEach(emit))
    return yield* finalResult(input)
  })

// emit + accumulate: the output is a fold over the stream (single pass)
run: (input, emit) =>
  source(input).pipe(
    Stream.runFoldEffect(
      () => "",
      (text, chunk) => emit({ token: chunk }).pipe(Effect.as(text + chunk)),
    ),
    Effect.map((text) => ({ text })),
  )
```

Compared with `run: Stream<Event>` + `finalize: (events) => Output`, this is the
same length but single-pass, and the framework no longer buffers the entire event
log to feed `finalize`: the tool accumulates only what its output needs.

### Consumer side unchanged

`Toolkit.run` still yields `Stream<ToolEvent>` with `Progress` + `Output`, so
`collectResults`, `continueWithResults`, and recipes are unaffected.

## Part C: composability (Option E, decided)

The toolkit is plain data; composability needs almost no new surface. Full
rationale and the alternatives weighed are in the exploration section below; the
decided design is:

1. **`streamTurn` accepts a toolkit** (kills the `descriptors` call at its source):

   ```ts
   // LanguageModel request
   readonly tools?: Toolkit | ReadonlyArray<ToolDescriptor>
   // normalize once at the boundary: Array.isArray(t) ? t : Toolkit.descriptors(t)

   streamTurn({ history, model, tools: toolkit })                              // common case
   streamTurn({ history, model, tools: [...Toolkit.descriptors(kit), hosted] }) // mix hosted tools
   ```

   Providers still receive `ToolDescriptor[]`, so provider decoupling and the
   hosted-tool story both hold.

2. **Middleware is a `Toolkit -> Toolkit` transform** (`Toolkit.wrap`). A middleware
   transforms one tool's `run` given its name; `wrap` lifts it over the toolkit,
   preserving each tool's `Input`/`Output` and unioning the middleware's `R2` into
   `ToolkitR` (native `Record.map` can't track `R2`, which is why this one
   combinator exists).

   ```ts
   type Middleware<R2 = never> = <I, O, Ev, R>(
     run: Handler<I, O, Ev, R>,
     name: string,
   ) => Handler<I, O, Ev, R | R2>

   export const wrap: <R2>(mw: Middleware<R2>) => <T extends Toolkit>(toolkit: T) => WithR<T, R2>

   const observed = pipe(toolkit, Toolkit.wrap(logging), Toolkit.wrap(withAuthz))
   Toolkit.run(observed, calls) // R = ToolkitR<typeof toolkit> | CurrentUser
   ```

3. **Override and mock are native record spread.** Replace one tool's `run`, keep
   its definition (so descriptors stay identical to prod, no drift). The only sugar
   is optional `Tool.withRun(tool, run)`, which gives the new `run` contextual input
   typing.

   ```ts
   const safe = {
     ...toolkit,
     send_email: Tool.withRun(toolkit.send_email, ({ to }) =>
       Effect.succeed({ status: "dry-run", to }),
     ),
   }
   const mockKit = {
     ...toolkit,
     get_weather: Tool.withRun(toolkit.get_weather, () => Effect.succeed({ tempC: 0 })),
   }
   ```

What Part C adds: a `Toolkit | ToolDescriptor[]` union on `streamTurn.tools` (+ one
normalize), `Toolkit.wrap`, and optional `Tool.withRun`. What it skips:
`def`/`implement`, a `Toolkit.override` combinator, Layer-as-toolkit, and a
pattern-match interpreter (all deferred or rejected, see below).

## Phasing

1. **Part A.** Add `Toolkit` (the indexed record) + `make` / `fromArray` /
   `descriptors` (+ optional `Tool.withName`), switch `run` and approval helpers to
   it, migrate recipes off hand-rolled descriptor arrays. Mechanical.
2. **Part B.** Add `emit` to `run`, delete `StreamingTool` / `streaming` /
   `finalize` / `isStreamingTool` (and the `AnyTool` union, leaving a plain alias),
   rewrite the executor to the queue model, migrate the streaming-tool recipes and
   skills.
3. **Part C.** Make `streamTurn.tools` accept `Toolkit | ToolDescriptor[]` (normalize
   in `LanguageModel`), add `Toolkit.wrap` + optional `Tool.withRun`, drop the
   hand-bound `Toolkit.descriptors` calls in recipes that don't mix hosted tools.
4. Keep `ToolValidationError` (input) from the stashed change; drop the rest.

## Non-goals

- **Typed per-call results.** Results arrive dynamically keyed by `call_id`, so
  typing `result.value` per call needs more than a keyed registry;
  `ToolResult.Ok.value` stays `unknown`.
- **Declaration / implementation separation.** Defining tools as pure
  declarations with handlers supplied separately (effect-ai style) helps only a
  narrow set of cases (shipping a contract, swap-implementation testing, an MCP
  dispatcher), costs boilerplate for ordinary recipes, and does not improve
  composition. Deferred. It can be added later without breaking Part A, since
  `Tool.def` + `Toolkit.implement` would produce the same `Toolkit` value as
  `Toolkit.make(...bundledTools)`.
- **Raw `channel()` escape hatch** for tools that fold incrementally. The `emit`
  model covers it via local accumulation.
- **MCP adapter** is its own plan (`mcp.md`); MCP tools are built as bundled tools
  (a `run` that calls the server, validating output inside `run`) and fed through
  `Toolkit.fromArray`.

---

# Exploration: definition/implementation separation + composability

Open question being revisited: should a tool's _implementation_ (`run`) be welded
into its _definition_ (name/description/schema, what the model sees), or split
apart? Driven by composability: how do we wrap a toolkit with metrics / auth,
override one tool, or mock it, in a functional, effect-native, low-boilerplate
way? This section is the rationale behind the **Part C** decision above (Option E):
it records the options weighed and why E won. The decision is locked; the options
remain for context.

## First, correct the premise

The `Toolkit.descriptors(toolkit)` call in `streamTurn({ tools })` is **not** a
consequence of bundling. `streamTurn` takes `ReadonlyArray<ToolDescriptor>` (the
provider wire form, confirmed in `LanguageModel.ts`), so _something_ always
renders defs → descriptors, bundled or separated. Two things make it a non-issue:

- **Bind once per recipe:** `const tools = Toolkit.descriptors(kit)`, then reuse.
  It is one line, not "everywhere".
- **Any separated design re-bundles** (see Option B): `implement(defs, handlers)`
  returns a single value that serves both `descriptors` and `run`, so call sites
  still thread one thing. Separation does not remove the render step.

So separation must justify itself on **composability**, not on the descriptors
call. Good news: that is exactly what this section measures.

## The composability primitives we actually want

```ts
// 1. Middleware: cross-cutting wrap of every tool's execution.
type Middleware<R2> = <I, O, Ev, R>(
  handler: Handler<I, O, Ev, R>,
  name: string,
) => Handler<I, O, Ev, R | R2>

// 2. Override: replace one tool's execution, keep its definition.
// 3. Mock: run the same model-facing contract with stand-in execution.
```

Key observation that shapes everything below: a `Toolkit` is a record of tools,
each with a `run` field. Middleware, override, and mock are therefore all just
**transforms over that record's handlers**. They do not require a separate
implementation type. The question is only which construction style makes them
cleanest, and what extra each style buys.

`Handler<I, O, Ev, R> = (input: I, emit: Emit<Ev>) => Effect<O, unknown, R>` is the
unit throughout.

## Option A: bundled record + `mapHandlers` / `override` (smallest step)

Keep `Tool.make({ ..., run })` and the record `Toolkit`. Add two combinators that
operate on the toolkit's handlers. Type-preservation: both keep each tool's
`Input`/`Output`; `mapHandlers` augments `R` by the middleware's `R2`.

```ts
// Toolkit.ts
export const mapHandlers: <T extends Toolkit, R2>(
  toolkit: T,
  mw: Middleware<R2>,
) => /* T with each tool's R widened by R2 */

export const override: <T extends Toolkit, K extends keyof T>(
  toolkit: T,
  patch: { [P in K]?: T[P]["run"] }, // new run, typed against that tool's Input/Output
) => T
```

Recipe point of view. **Middleware** (metrics + authz, stacked):

```ts
const withTiming: Middleware<MetricsEnv> = (handler, name) => (input, emit) =>
  handler(input, emit).pipe(
    Effect.timed,
    Effect.flatMap(([d, out]) => recordToolDuration(name, d).pipe(Effect.as(out))),
  )

const withAuthz: Middleware<CurrentUser> = (handler, name) => (input, emit) =>
  CurrentUser.pipe(
    Effect.flatMap((u) => (u.can(name) ? handler(input, emit) : Effect.fail(new Forbidden(name)))),
  )

const observed = toolkit.pipe(Toolkit.mapHandlers(withTiming), Toolkit.mapHandlers(withAuthz)) // Toolkit.run(observed, calls): R now includes MetricsEnv | CurrentUser
```

**Override** one tool (dry-run send_email), keeping its definition:

```ts
const safe = Toolkit.override(toolkit, {
  send_email: ({ to }) => Effect.succeed({ status: "dry-run", to }),
})
```

**Mock** for tests, reusing the _real_ definitions (so the model-facing contract
is identical to prod, no drift):

```ts
const mockKit = Toolkit.override(toolkit, {
  get_weather: () => Effect.succeed({ tempC: 0 }),
  send_email: () => Effect.succeed({ status: "sent" }),
})
```

What Option A covers: middleware, override, and mock-with-contract-fidelity, all
via two combinators on the value we already have. What it does **not** give:
shipping a definition with no implementation at all (a contract package), and a
compile-time "every tool is implemented" checkpoint (override is partial by
design).

## Option B: `Tool.def` + `Toolkit.implement` (separation as an alternative constructor)

Split the definition (pure data, `R = never`, what the model sees) from the
handler. Crucially, `implement` **re-bundles** into the _same_ `Toolkit` value
Option A operates on, so this is additive: a second way to construct a toolkit,
not a second runtime type. `Output`/`Event`/`R` are inferred from the handler
(no output schema, no phantom on the def).

```ts
interface ToolDef<Name extends string, Input> {
  readonly name: Name
  readonly description: string
  readonly inputSchema: ToolInputSchema<Input>
  readonly strict?: boolean
}
export const def: <Name extends string, Input>(spec: ToolDef<Name, Input>) => ToolDef<Name, Input>

// A definition set: name-indexed record of defs (renders descriptors, decodes).
export const defs: <const D extends ReadonlyArray<ToolDef<string, any>>>(
  ...d: D
) => { [T in D[number] as T["name"]]: T }

// Implement: every def gets a handler whose Input is the def's Input. Returns the
// SAME Toolkit value as Toolkit.make(...) — descriptors + run, ToolkitR = ∪ handler R.
export const implement: <D extends DefMap, H extends { [K in keyof D]: Handler<InputOf<D[K]>, any, any, any> }>(
  defs: D,
  handlers: H,
) => Toolkit</* { [K]: Tool<K, InputOf<D[K]>, EventOf<H[K]>, OutputOf<H[K]>, ROf<H[K]>> } */>

// Implement a whole namespace with one dispatcher (MCP, RPC):
export const implementWith: <D extends DefMap, R>(
  defs: D,
  dispatch: (name: keyof D & string, input: unknown, emit: Emit<unknown>) => Effect<unknown, unknown, R>,
) => Toolkit
```

Recipe point of view:

```ts
const toolDefs = Toolkit.defs(
  Tool.def({ name: "get_weather", description, inputSchema: weatherIn }),
  Tool.def({ name: "send_email", description, inputSchema: emailIn }),
)

const kit = Toolkit.implement(toolDefs, {
  get_weather: ({ city }) => Effect.succeed({ tempC: 18 }), // input typed from the def
  send_email: ({ to }, emit) => sendWithProgress(to, emit),
})

const tools = Toolkit.descriptors(kit) // identical call site to Option A
Toolkit.run(kit, calls)
```

Middleware and override are identical to Option A (they act on the re-bundled
`kit`). **Mock** gets its cleanest form: re-implement the _same defs_, which
guarantees byte-identical descriptors and exhaustiveness in one step:

```ts
const mockKit = Toolkit.implement(toolDefs, {
  get_weather: () => Effect.succeed({ tempC: 0 }),
  send_email: () => Effect.succeed({ status: "sent" }),
}) // compile error if a def is left unimplemented
```

What Option B adds over A:

- **Contract shipping:** a library exports `toolDefs` (pure data, no `R`, no impl);
  consumers implement. Bundled tools can't be shipped impl-less.
- **Exhaustiveness:** `implement` requires a handler for every def (a missing tool
  is a compile error), which override (partial by nature) can't give.
- **Bulk dispatcher:** `implementWith(defs, dispatch)` for MCP/RPC namespaces,
  rather than fabricating N near-identical tool objects.
- **Multi-implementation:** one `defs`, many `implement(...)` (prod, mock, a
  different backend) without restating the contract.

Cost: a second constructor and the `def`/`implement` split to learn; for a
one-tool script it is more ceremony than `Tool.make`. The handler record repeats
each tool name as a key (inherent to keying by name; effect-ai has the same).

## Option C: effect-ai style, toolkit as a Context service + `toLayer`

The toolkit definition is a `Context.Tag`; handlers are provided as a `Layer`.

```ts
class Tools extends Context.Tag("app/Tools")<Tools, Handlers>() {}

const ToolsLive = Layer.succeed(Tools, {
  get_weather: ({ city }) => Effect.succeed({ tempC: 18 }),
  send_email: ({ to }, emit) => sendWithProgress(to, emit),
})

// Middleware = a Layer transform.
const withTiming = <E, R>(self: Layer<Tools, E, R>) =>
  Layer.map(self, (handlers) => mapHandlers(handlers, timing))

// Run pulls handlers from context; mock = provide a different layer.
program.pipe(Effect.provide(ToolsLive)) // prod
program.pipe(Effect.provide(ToolsMock)) // test
```

Pros: middleware and mock ride the standard `Layer` machinery; handler `R` becomes
the layer's `RIn`, composed in the layer graph; late binding is free. Cons: the
most ceremony (tag + layer to run anything); it makes the toolkit a _service_
resolved ambiently, which collides with this codebase's "recipe drives the loop
and holds the toolkit as a value" stance; and you still render `defs → descriptors`
separately for `streamTurn`. Justified only if tools must be resolved deep in a
call graph without being passed, or a plugin system contributes tools to a shared
registry. Neither is our model today.

## Option D: interpreter / pattern-match over a tagged union

Defs are a tagged union; a single `execute` matches the call and dispatches;
middleware wraps `execute`.

```ts
const execute = (call: DecodedCall): Effect<ToolResult, never, R> =>
  Match.value(call).pipe(
    Match.tag("get_weather", ({ city }) => ...),
    Match.tag("send_email", ({ to }) => ...),
    Match.exhaustive,
  )
const observed = withTiming(execute)
```

Maximally explicit and exhaustive, and middleware is a plain function wrap. But it
is the verbose option the earlier discussion already set aside: every tool is
spelled twice (union member + match arm), and decode/dispatch is hand-rolled
rather than keyed by name.

## Synthesis and recommendation

The runtime model should stay the **record `Toolkit`** from Part A. Layer it:

1. **Always add `Toolkit.mapHandlers` + `Toolkit.override`** (Option A). They are
   small, they make middleware / override / mock first-class on the value we
   already have, and they cover the three composability asks with contract
   fidelity. This is the high-value, low-cost core of "make toolkits composable".
2. **Offer `Tool.def` + `Toolkit.implement` / `implementWith` as an additive
   alternative constructor** (Option B) that produces the _same_ `Toolkit`. Reach
   for it when you want a shipped contract, compile-time exhaustiveness, multiple
   implementations of one contract, or a dispatcher-implemented namespace (MCP).
   `Tool.make` stays the one-liner for the common case; `def`/`implement` is the
   power tool. Because both yield the same value, `mapHandlers`/`override` and
   `run`/`descriptors` work regardless of how the toolkit was built.
3. **Do not adopt Option C (Layer/service) as the default**, and **do not adopt
   Option D**. C's ambient-service model fights the explicit recipe style and adds
   ceremony for no composability win over (1); D is too verbose. A thin
   `Toolkit.layer(handlers)` adapter can exist for users who genuinely want the
   service pattern, but it is opt-in, not the spine.

Net: keep the simple `run`-in-the-tool authoring path the user likes, get
middleware/override/mock from two combinators, and treat full def/impl separation
as an opt-in constructor for the cases that truly need a standalone contract. This
keeps call sites unchanged (one toolkit value, bound-once descriptors) while
making composition explicit, type-safe, and functional.

### Open questions

- Do we want `mapHandlers`/`override` to preserve precise per-tool `Output` types,
  or is widening acceptable? Precise preservation needs a mapped type over the
  record; worth it for `override` (you want the patched run typed against the def),
  less critical for `mapHandlers`.
- If we add `Tool.def`/`implement`, does `implement` allow _partial_ coverage (the
  rest defaulting to a "not implemented" failure) or require exhaustiveness? Lean
  exhaustive, with `implementWith` as the escape hatch for dispatcher namespaces.

## Reconsidered (Option E): the toolkit is plain data; add almost nothing

Feedback on A–D: A wraps what record spread / `Record.map` already do (reinventing
the wheel); B is an interface+registry (OOP in disguise, the most boilerplate); C
(Layer) is ceremony and makes the toolkit an ambient service. The clarifying point:
the `Toolkit.descriptors(kit)` line exists only because `streamTurn` takes wire
descriptors while the toolkit also carries `run`. If `streamTurn` accepted the
toolkit, that line disappears, and then composition is just native data ops. Two
small moves, no new tool model:

### 1. `streamTurn` accepts a toolkit (kills the `descriptors` call)

```ts
// LanguageModel request
readonly tools?: Toolkit | ReadonlyArray<ToolDescriptor>
// normalize once at the boundary: Array.isArray(t) ? t : Toolkit.descriptors(t)
```

```ts
streamTurn({ history, model, tools: toolkit }) // common case, no descriptors() call
streamTurn({ history, model, tools: [...Toolkit.descriptors(kit), hostedWebSearch] }) // mix hosted tools
```

Providers still receive `ToolDescriptor[]` (normalization happens in the
`LanguageModel` facade before dispatch), so the provider decoupling and the
hosted-tool story both hold. The cost is a one-place `Array.isArray` normalize and
`LanguageModel` gaining a runtime dependency on `Toolkit.descriptors` (it already
depends on the `ToolDescriptor` type). This reverses the earlier "keep
`ToolDescriptor[]` only" call, on the grounds that the union keeps the hosted-tool
escape hatch while removing the friction the user actually hit.

### 2. Middleware as a `Toolkit → Toolkit` transform (`Toolkit.wrap`)

Middleware is a transform you apply to the toolkit up front, then run the wrapped
toolkit (not a hook passed into `run`). A _middleware_ is the use-case-specific
part: transform one tool's `run` given its name. `Toolkit.wrap` lifts it over the
whole toolkit. This is the one combinator worth having, because native
`Record.map` produces a uniform value type and can't track the added `R2` — so it
would widen `toolkit.get_weather` and drop `R2` from `ToolkitR`. `Toolkit.wrap`'s
mapped return preserves each tool's `Input`/`Output` and unions `R2` in.

```ts
type Middleware<R2 = never> = <I, O, Ev, R>(
  run: Handler<I, O, Ev, R>,
  name: string,
) => Handler<I, O, Ev, R | R2>

type WithR<T extends Toolkit, R2> = {
  [K in keyof T]: T[K] extends Tool<infer N, infer I, infer Ev, infer O, infer R>
    ? Tool<N, I, Ev, O, R | R2>
    : T[K]
}

export const wrap: <R2>(mw: Middleware<R2>) => <T extends Toolkit>(toolkit: T) => WithR<T, R2>
//   = (mw) => (tk) => Object.fromEntries(
//       Object.entries(tk).map(([name, tool]) => [name, { ...tool, run: mw(tool.run, name) }]))
```

Defining an arbitrary middleware is one small function; applying it is `pipe`
(the plain-record toolkit has no `.pipe` method, so use the `pipe` function):

```ts
const logging: Middleware = (run, name) => (input, emit) =>
  Effect.logInfo(`tool:${name}`, input).pipe(Effect.zipRight(run(input, emit)))

const retrying: Middleware = (run) => (input, emit) =>
  run(input, emit).pipe(Effect.retry(Schedule.exponential("100 millis")))

const withAuthz: Middleware<CurrentUser> = (run, name) => (input, emit) =>
  CurrentUser.pipe(
    Effect.flatMap((u) => (u.can(name) ? run(input, emit) : Effect.fail(new Forbidden(name)))),
  )

const observed = pipe(
  toolkit,
  Toolkit.wrap(logging),
  Toolkit.wrap(retrying),
  Toolkit.wrap(withAuthz),
)
Toolkit.run(observed, calls) // R = ToolkitR<typeof toolkit> | CurrentUser
```

An auth `Effect.fail` is caught by the executor into a `ToolResult.Failure` like
any run failure (use the Approval flow for a distinct "denied" verdict). A shipped
toolkit with baked-in middleware is just `pipe(kit, Toolkit.wrap(...))` exported
from the library.

### 3. Override and mock are native record ops

No combinators. Spread the toolkit, replace one tool's `run`, keep its definition.
`Tool.withRun(tool, run)` is the only sugar (it gives `run`'s input contextual
typing so you skip the annotation); even that is optional.

```ts
// Override one tool (dry-run), definition unchanged
const safe = {
  ...toolkit,
  send_email: Tool.withRun(toolkit.send_email, ({ to }) =>
    Effect.succeed({ status: "dry-run", to }),
  ),
}

// Mock for tests: same definitions (identical descriptors), stand-in execution
const mockKit = {
  ...toolkit,
  get_weather: Tool.withRun(toolkit.get_weather, () => Effect.succeed({ tempC: 0 })),
}
```

### What Option E costs and skips

- **Adds:** a `Toolkit | ToolDescriptor[]` union on `streamTurn.tools` (+ one
  normalize), a `Toolkit.wrap(middleware)` combinator (`Toolkit → Toolkit`), and
  optional `Tool.withRun` sugar.
- **Skips:** `def`/`implement`, `Toolkit.override` (native spread covers it),
  Layer/service, pattern-match interpreter. No def/impl separation.
- **Loses vs B:** shipping an implementation-less contract and compile-time
  exhaustiveness. If those ever matter (a published tool contract, an MCP
  dispatcher), add `Tool.def`/`implement` later as the additive constructor from
  Option B — it produces the same `Toolkit` value, so `wrap`, `withRun`, `run`, and
  toolkit-accepting `streamTurn` keep working unchanged.

### Which encoding this is, and why it fits

Tools are an algebra (the definitions) with a few interpreters (`descriptors`
renders them to wire form, `run` evaluates a call, mock is an alternative, `wrap`
is an interpreter transformer). Naming the encodings precisely:

- **Initial = pure data + one external fold** that supplies all behavior. For
  tools that is **Option D** (a tagged union of defs + one `execute` that
  pattern-matches). Adding an interpreter is cheap; adding a _tool_ is expensive
  (touch every fold). Verbose; rejected.
- **Final / object (records of functions)** = each tool carries its own behavior
  as a closure; the toolkit is a record of them. This is **Option E** (and B's
  runtime shape — B only decouples construction). `run` is a generic dispatcher,
  not a behavior-supplying interpreter. Adding a _tool_ is trivial (one record
  entry); the few interpreters stay generic (descriptors reads the data fields,
  `run` dispatches, `wrap`/mock transform closures), so they never need per-tool
  behavior. (Note: separating `run` from the tool does _not_ make it "initial" —
  it is still a record of functions; only Option D is the initial encoding.)
- **Tagless-final** = the carrier-polymorphic generalization of the object
  encoding, via HKT. This is **Option C** (Effect services + `Layer`).

Why E and not C or D:

1. **Expression-problem profile.** We add tools often and interpreters rarely, so
   we want the encoding where adding a _variant_ is cheap (object / E), not the
   one where adding an interpreter is cheap but variants are expensive
   (initial / D).
2. **One carrier.** Tagless-final's payoff is writing programs polymorphic over
   the interpreter carrier `F` (Effect, a test monad, ...). We have exactly one
   carrier (Effect) and never write carrier-polymorphic tool programs, so the
   polymorphism is dead weight — and in HKT-less TypeScript you pay encoding
   ceremony for it.
3. **No composite tool-programs.** Free monad's payoff is folding a program built
   from the algebra. The model emits flat, independent calls; what composition
   exists lives in the **Loop** (turn → results → next turn), not in tools. So
   there is nothing to fold at the tool layer (Free belongs at the Loop layer, cf.
   `internal-docs/conversation-as-unfold.md`).

Decisive point: this is **not** "data instead of Layers" for _dependencies_. A
handler's `R` is still surfaced in `run`'s type and provided by a `Layer` at the
recipe boundary. Option C conflates the tool registry with the DI mechanism;
Option E keeps **tools as a record of functions, dependencies as Layers** — losing
none of Layer's dependency power while keeping the toolkit a first-class value.
Layers-as-toolkit would only win if tools had to be resolved ambiently across a
large call graph, or if assembling the handler set itself needed app-wide managed
resources. The tool layer has neither.

### Recommendation

Adopt **Option E** as the composability story: the toolkit is plain data, the
`descriptors` friction is removed at its source (toolkit-accepting `streamTurn`),
and middleware/override/mock come from one `Toolkit.wrap` combinator plus native
spread — no registry, no Layer-as-toolkit. Keep Option B's `def`/`implement` on
the shelf as an opt-in constructor for the contract/exhaustiveness cases only.
