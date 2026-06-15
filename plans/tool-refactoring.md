# Plan: Tool refactoring (Toolkit type + streaming tools)

Two breaking changes to the tool layer, landing together as one version bump:

1. **Record `Toolkit`.** Replace `ReadonlyArray<AnyTool>` with a name-indexed
   `Toolkit` value that owns its rendered descriptors.
2. **Unified `run` with `emit`.** Replace the streaming tool's `run` + `finalize`
   pair with a single `run(input, emit) => Effect<Output>`, collapsing plain and
   streaming tools into one shape.

## Design decisions

- **Input schema stays, no output schema.** Input is the one wire boundary (the
  LLM returns `arguments` as an untyped JSON string), so it is parsed and
  validated locally and is the only schema providers consume. A `run` produces its
  result in TypeScript, so its type already guarantees the shape; output
  validation only makes sense at a real runtime boundary (an external/MCP call
  inside `run`), where it lives, not as a static `Tool` field.
- **Tools stay bundled:** `Tool.make({ ..., run })`. Definition and execution are
  one object. (Separating them is a non-goal here, see below.)
- **`emit` is `(e) => Effect<void>`** for backpressure.
- **A `Toolkit` is a value, not a Context service.** Handler `R` is surfaced in
  `run`'s type and provided with a `Layer` at the recipe boundary, as today.
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
const toolkit  = Toolkit.make(...weatherTools, ...prefixed)
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
  toolkit: T, calls: ReadonlyArray<ToolCall>, options?: ExecuteOptions,
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
its done value, the executor accumulates *every* event into a `Ref` just to feed
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
  readonly emitBufferSize?: number   // this tool's emit-queue bound; unbounded default
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
    const input = yield* decodeAndValidate(tool, call)          // input boundary
    const queue = yield* Queue.make<Event, Cause.Done>(tool.emitBufferSize)
    const emit: Emit<Event> = (e) => Queue.offer(queue, e)
    const fiber = yield* tool.run(input, emit).pipe(Effect.ensuring(Queue.end(queue)), Effect.fork)

    const progress = Stream.fromQueue(queue).pipe(
      Stream.map((data) => ToolEvent.Progress({ call_id: call.call_id, tool: tool.name, data })),
    )
    const output = Stream.fromEffect(
      Fiber.join(fiber).pipe(
        Effect.map((value) => ToolEvent.Output({ result: okResult(call, tool.name, value) })),
        Effect.catchCause(() => Effect.succeed(ToolEvent.Output({ result: executionError(call, "Tool execution failed") }))),
      ),
    )
    return progress.pipe(Stream.concat(output))                 // progress drains, then output
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
    Stream.runFoldEffect(() => "", (text, chunk) =>
      emit({ token: chunk }).pipe(Effect.as(text + chunk))),
    Effect.map((text) => ({ text })),
  )
```

Compared with `run: Stream<Event>` + `finalize: (events) => Output`, this is the
same length but single-pass, and the framework no longer buffers the entire event
log to feed `finalize`: the tool accumulates only what its output needs.

### Consumer side unchanged

`Toolkit.run` still yields `Stream<ToolEvent>` with `Progress` + `Output`, so
`collectResults`, `continueWithResults`, and recipes are unaffected.

## Phasing

1. **Part A.** Add `Toolkit` (the indexed record) + `make` / `fromArray` /
   `descriptors` (+ optional `Tool.withName`), switch `run` and approval helpers to
   it, migrate recipes off hand-rolled descriptor arrays. Mechanical.
2. **Part B.** Add `emit` to `run`, delete `StreamingTool` / `streaming` /
   `finalize` / `isStreamingTool` (and the `AnyTool` union, leaving a plain alias),
   rewrite the executor to the queue model, migrate the streaming-tool recipes and
   skills.
3. Keep `ToolValidationError` (input) from the stashed change; drop the rest.

## Non-goals

- **Typed per-call results.** Results arrive dynamically keyed by `call_id`, so
  typing `result.value` per call needs more than a keyed registry;
  `ToolResult.Ok.value` stays `unknown`.
- **Declaration / implementation separation.** Defining tools as pure
  declarations with handlers supplied separately (effect-ai style) helps only a
  narrow set of cases (shipping a contract, swap-implementation testing, an MCP
  dispatcher), costs boilerplate for ordinary recipes, and does not improve
  composition. Deferred. It can be added later without breaking Part A, since
  `Tool.declare` + `Toolkit.implement` would produce the same `Toolkit` value as
  `Toolkit.make(...bundledTools)`.
- **Raw `channel()` escape hatch** for tools that fold incrementally. The `emit`
  model covers it via local accumulation.
- **MCP adapter** is its own plan (`mcp.md`); MCP tools are built as bundled tools
  (a `run` that calls the server, validating output inside `run`) and fed through
  `Toolkit.fromArray`.
