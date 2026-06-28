---
title: Tools and toolkits
description: Defining tools, streaming progress via emit, toolkits, explicit execution, structured results, approval gating, and history reconciliation.
---

Tools are typed Effects your loop decides to run, not callbacks hidden inside
an agent runtime. The model emits `ToolCall` items; your harness inspects
them, applies any policy, and passes approved calls to `Toolkit.run`.
The executor renders schemas, validates arguments, runs the tool, and turns
success or failure into structured `ToolResult`s. You own `run` and every
policy decision around it.

Most tools have a local `run`: an `Effect` that computes the model-facing
`Output`. It also receives an `emit` function for streaming intermediate events
to the consumer in real time (sub-agent reasoning, download progress). A plain
tool just ignores `emit`; a streaming tool calls it. `Tool.make` builds these.

Some model-visible tools have **no** local `run`: they are executed by the
provider, or they are signals the loop interprets. Those are the other three
[tool kinds](#tool-kinds) (`Tool.provider`, `Tool.signal`, `Tool.interaction`);
the executor reports them as `non_local_tool` rather than pretending to run a
fake handler.

## `Tool.make`: defining a tool

```ts
import { Effect, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"

const GetCurrentTimeInput = Schema.Struct({
  timezone: Schema.String,
})

const getCurrentTime = Tool.make({
  name: "get_current_time",
  description: "Look up the current local time for an IANA timezone.",
  inputSchema: Tool.fromEffectSchema(GetCurrentTimeInput),
  run: ({ timezone }) => Effect.succeed({ timezone, iso: new Date().toISOString() }),
  strict: true,
})
```

A `Tool` is `{ name, description, inputSchema, run, emitBufferSize?, strict? }`.
`run` is `(input, emit) => Effect<Output, unknown, R>`; its requirements flow
out via the executor. The plain tool above never calls `emit`.

`strict` (default `true`) toggles the provider's strict-mode flag
(OpenAI's `strict: true`, Gemini's equivalent). The framework never
rewrites your schema; if the rendered JSON Schema is incompatible with
strict mode, the provider errors and you drop `strict` or simplify it.

## Tool kinds

Every tool is model-visible (it renders a descriptor), but only `Tool.make`
tools are locally executable. The four kinds, discriminated by `_tag`:

| Constructor        | Executed by                                              | Use for                                                   |
| ------------------ | -------------------------------------------------------- | --------------------------------------------------------- |
| `Tool.make`        | your `run`, via `Toolkit.run`                            | ordinary local tools (weather, send email)                |
| `Tool.provider`    | the provider                                             | provider-hosted web search, code execution, RAG grounding |
| `Tool.signal`      | nobody (the loop **interprets** the call)                | escalate, pause, schedule, hand off                       |
| `Tool.interaction` | an external actor (the loop **stops and resumes** later) | "ask the user to choose an account"                       |

`Tool.signal` and `Tool.interaction` are decode-only: they carry a `name`,
`description`, and `inputSchema` but no `run`. You decode the arguments with
`Tool.decodeArgs(signal, call)` and act on them (advance a tier, schedule a
wake-up, stop for input) where the loop interprets the call, instead of running
a handler:

```ts
const escalate = Tool.signal({
  name: "escalate",
  description: "Hand the question to a stronger model.",
  inputSchema: Tool.fromEffectSchema(EscalateInput),
})

// in onTurnComplete:
const call = Turn.getToolCalls(turn).find((c) => c.name === "escalate")
if (call !== undefined) {
  return Tool.decodeArgs(escalate, call).pipe(Effect.map((args) => next({ tier: 1, ...args })))
}
```

If a non-local kind is ever passed to `Toolkit.run` (the loop forgot to
intercept it), the executor returns `Failure(non_local_tool)` for that call
rather than crashing, distinct from `unknown_tool` (no such tool at all).

`Tool.provider` additionally carries `provider` and `config` for the provider
adapter to render its hosted tool natively.

## Streaming with `emit`

To stream progress, call `emit(event)` inside `run`. Each event reaches the
consumer as a `ToolEvent.Progress` in real time; `run` still returns the single
`Output` the model sees. `emit` is `(event) => Effect<void>`, so it drops
straight into `Stream.runForEach` / `Stream.runFoldEffect`: fold the events into
the output in one pass (no buffering of the whole event log):

```ts
import { Effect, Stream } from "effect"

const askSubagent = Tool.make({
  name: "ask_subagent",
  description: "Ask a specialist sub-agent for help.",
  inputSchema: Tool.fromEffectSchema(SubAgentInput),
  run: ({ question }, emit) =>
    runInner(question).pipe(
      // emit each inner event; fold the text deltas into the answer
      Stream.runFoldEffect(
        () => "",
        (answer, event) =>
          emit(event).pipe(Effect.as(event._tag === "TextDelta" ? answer + event.text : answer)),
      ),
      Effect.map((answer): SubAgentOutput => ({ answer })),
    ),
  strict: true,
})
```

Set `emitBufferSize` on the tool to bound its emit queue (unbounded by default)
when it emits faster than the consumer drains. More patterns (text concat,
result list, progress + terminal) sit side-by-side in the
[Streaming tool output recipe](/recipes/streaming-tool-output/).

## `inputSchema`: any Standard Schema

`inputSchema` is `StandardSchemaV1 & StandardJSONSchemaV1`. Zod 4+,
Valibot, and ArkType implement both directly; Effect Schema needs
`Tool.fromEffectSchema` to attach the two extensions.

Two adapters cover the two cases:

- `Tool.fromEffectSchema(schema)`: wrap an Effect Schema so it
  carries the JSON Schema renderer.
- `Tool.fromStandardSchema(schema)`: type-narrowing identity for
  schemas that already implement both Standard interfaces (Zod 4+,
  Valibot, ArkType). Use this so TypeScript pins the inferred input
  type at the tool boundary instead of falling back to `unknown`.

The same schema serves two purposes:

- **Wire rendering**: descriptor rendering calls
  `inputSchema.~standard.jsonSchema.input({ target: "draft-2020-12" })`
  to produce the JSON Schema each provider sends (`Toolkit.descriptors`,
  or the low-level `Tool.toDescriptors`).
- **Argument validation**: when a `ToolCall` arrives, the executor
  parses arguments, validates them, and either passes the parsed value
  to `run` or synthesizes a `Failure(input_validation_error)`.

## Wiring tools up

Group your tools into a `Toolkit` (a name-indexed record of tools) with
`Toolkit.make(...tools)`, then pass the toolkit straight to `streamTurn`:

```ts
import * as Toolkit from "@effect-uai/core/Toolkit"

const toolkit = Toolkit.make(
  getCurrentTime, // plain
  askSubagent, // streaming
)

lm.streamTurn({ history, model, tools: toolkit })
```

`streamTurn` takes the `Toolkit` directly and renders the wire descriptors at
the provider boundary, so there's no `descriptors` call at the call site. (The
explicit `Toolkit.descriptors(toolkit)` still exists if you want the
`ToolDescriptor[]` yourself.)

`Toolkit.make` is variadic, indexes by `tool.name`, and **rejects a duplicate
literal name at compile time**. Use `Toolkit.fromArray(tools)` for a
runtime-built array (e.g. MCP), where names are trusted and last-wins. The rendered descriptors are the
provider-agnostic `ToolDescriptor[]` the generic `LanguageModel` accepts;
providers map `inputSchema` to their own wire field (`parameters` for OpenAI,
`input_schema` for Anthropic).

### Composing toolkits

Combine independently-built toolkits (built-ins, MCP servers, signal sets) with
`Toolkit.compose`. It is the application boundary where names from separate
sources can collide, so it is effectful: a duplicate final name fails with
`DuplicateToolName` naming the colliding inputs, instead of silently overwriting
or 400-ing later at the provider. Static collisions are additionally a compile
error.

```ts
const github = Toolkit.fromArray(githubTools)
const linear = Toolkit.fromArray(linearTools)

// both expose `search` -> DuplicateToolName{ name: "search", sources: [...] }
const toolkit = yield * Toolkit.compose(github, linear)
```

Keep generic names distinct by prefixing first: `Toolkit.namespace("github",
github)` renames every tool to `github__search`, so the compose succeeds.
`Toolkit.makeNamespaced("github", ...tools)` does both in one step.

### Middleware

`Toolkit.wrap(middleware)` is a `Toolkit → Toolkit` transform applied up front;
it wraps every local tool's `run` (logging, retry, auth, metrics) and leaves
provider/signal/interaction kinds untouched. It tracks the middleware's added
requirement `R2`, unioning it into the toolkit's requirements:

```ts
const logging: Toolkit.Middleware = (run, name) => (input, emit) =>
  Effect.logInfo(`tool:${name}`).pipe(Effect.zipRight(run(input, emit)))

const observed = pipe(toolkit, Toolkit.wrap(logging), Toolkit.wrap(withAuthz))
```

To override or mock a single tool while keeping its model-facing descriptor
identical, spread the record and swap one `run` with `Tool.withRun`:

```ts
const dryRun = {
  ...toolkit,
  send_email: Tool.withRun(toolkit.send_email, ({ to }) =>
    Effect.succeed({ status: "dry-run", to }),
  ),
}
```

### Tools with service requirements

A tool's `run` is just an `Effect`, so it can declare service
requirements on its `R` channel. Each tool keeps its own `R`; the
executor surfaces the union for the caller to provide via `Layer`.

```ts
import { Context, Effect, Layer, Stream } from "effect"

class WeatherApiKey extends Context.Service<WeatherApiKey, { readonly key: string }>()(
  "app/WeatherApiKey",
) {}
class GeoApiKey extends Context.Service<GeoApiKey, { readonly key: string }>()("app/GeoApiKey") {}

const lookupWeather = Tool.make({
  name: "lookup_weather",
  description: "Current weather for a city.",
  inputSchema: Tool.fromEffectSchema(LookupWeatherInput),
  run: ({ city }) =>
    Effect.gen(function* () {
      const { key } = yield* WeatherApiKey
      return yield* fetchWeather(key, city)
    }),
})

const getCoords = Tool.make({
  name: "get_coords",
  description: "Coordinates for a place.",
  inputSchema: Tool.fromEffectSchema(GetCoordsInput),
  run: ({ place }) =>
    Effect.gen(function* () {
      const { key } = yield* GeoApiKey
      return yield* fetchCoords(key, place)
    }),
})

const events = Toolkit.run(Toolkit.make(lookupWeather, getCoords), calls)
//   ^? Stream<ToolEvent, never, WeatherApiKey | GeoApiKey>

const Live = Layer.mergeAll(
  Layer.succeed(WeatherApiKey, { key: process.env.WEATHER_KEY! }),
  Layer.succeed(GeoApiKey, { key: process.env.GEO_KEY! }),
)

events.pipe(Stream.provide(Live))
```

The compiler enforces that every required service is provided before
the stream runs. Tools that need nothing keep `R = never`.

## `Toolkit.run`: the executor

```ts
import * as Toolkit from "@effect-uai/core/Toolkit"

const events = Toolkit.run(toolkit, calls)
//   ^? Stream<ToolEvent>
```

`run` takes a `Toolkit`, dispatches each call by name (O(1)), runs every
requested tool concurrently, and emits a `Stream<ToolEvent>` in real time. Three
event variants:

- **`Progress`**: one per event a tool emits via `emit`. Tools that never
  call `emit` produce none.
- **`Output`**: one per call, terminal. Carries a structured `ToolResult`.
- **`ApprovalRequested`**: emitted by `fromQueue` for gated calls.

Graceful by default: hallucinated tool names become `Failure(unknown_tool)`
for that call only; a model-visible but non-local kind (provider/signal/
interaction) that wasn't intercepted becomes `Failure(non_local_tool)`; input
that fails the schema becomes `Failure(input_validation_error)` and runtime
crashes become `Failure(execution_error)`. Concurrency defaults to
`"unbounded"`; pass `{ concurrency: 4 }` to bound it.

## `ToolResult`: structured results

The executor speaks in `ToolResult` (structured), not `ToolCallOutput`
(wire-shaped). Recipes can inspect, redact, audit, or re-route values
before serialization without parse-and-restringify.

```ts
type ToolResult =
  | { _tag: "Ok"; call_id: string; tool: string; value: unknown }
  | { _tag: "Failure"; call_id: string; tool: string; kind: string; reason?: string }
```

Synthesizers from `@effect-uai/core/ToolResult`: `denied`, `cancelled`,
`executionError`, `nonLocalTool`, plus `failed(call, kind, reason)` for any
custom string kind. The executor doesn't inspect `kind`. It's recipe-level
metadata for audit logs and pattern-matching downstream.

## Wire conversion at the boundary

`Stream<ToolEvent>` carries structured values; `state.history` carries
wire-shaped `ToolCallOutput`s. The single explicit conversion point
is `toToolCallOutput`, applied where results meet history. See the
round-trip below.

## The round-trip shape

The full pattern is in [Basic usage](/recipes/basic-usage/). The body:

```ts
onTurnComplete((turn) =>
  Effect.sync(() => {
    const calls = Turn.getToolCalls(turn)
    // If the model did not ask for tools, this conversation is done.
    if (calls.length === 0) return stop()

    return Toolkit.run(toolkit, calls).pipe(
      Toolkit.continueWithResults((results) =>
        // Provider history needs both the function_call items and their outputs.
        Turn.appendToHistory(state, turn, results.map(toToolCallOutput)),
      ),
    )
  }),
)
```

`Turn.appendToHistory` appends the turn's items (including the `ToolCall`s
themselves) and then the collected `ToolCallOutput`s. Both must be
present for the model to see what it asked for _and_ what came back.

## Approval gating

For HITL, `run` stays the only executor. Approval helpers return
plain data the recipe composes explicitly:

```ts
type ToolCallPlan = {
  readonly approved: ReadonlyArray<ToolCall>
  readonly rejected: ReadonlyArray<ToolResult>
}
```

HTTP/request-shaped flows use `fromMap(predicate, approvals)(calls)`,
which splits calls into approved and rejected up front:

```ts
const plan = fromMap(isSensitive, approvals)(calls)
const events = Stream.merge(
  Toolkit.run(toolkit, plan.approved),
  Stream.fromIterable(plan.rejected.map((result) => ToolEvent.Output({ result }))),
)
```

Long-lived queue flows use `fromQueue(predicate, verdicts)(calls)`,
which returns safe calls up front, an `approvalRequests` stream of
`ApprovalRequested` events, and a decision stream for gated calls as
verdicts arrive:

```ts
const { approved, decisions, approvalRequests } = yield * fromQueue(isSensitive, verdicts)(calls)

const events = Stream.merge(
  approvalRequests,
  Stream.merge(Toolkit.run(toolkit, approved), decisions.pipe(Stream.flatMap(decisionToEvents))),
)
```

Either way, every model-requested call receives a matching tool result
in history. Full walkthrough in the
[Tool call approval recipe](/recipes/tool-call-approval/).

## History reconciliation

Every provider rejects a new request if any prior `function_call`
lacks a matching `function_call_output`. Flows that can be interrupted,
restarted, or branched (HITL, mid-stream abort, checkpoints, stateless
HTTP servers) need to detect orphans and synthesize closure outputs
before submitting:

```ts
import { cancelAllPending, findUnansweredCalls, isReconciled } from "@effect-uai/core/HistoryCheck"

const closures = cancelAllPending(history, "user moved on")
const reconciled = [...history, ...closures.map(toToolCallOutput)]
```

Call these at known transition points; not from inside the loop.

## What's not built in

- **No retry policies**: wrap `tool.run` with `Effect.retry`.
- **No per-tool timeout**: compose with `Effect.timeout`.
- **No magic history reconciliation**: `cancelAllPending` is explicit.

Policy decisions stay in the recipe; the primitives give you the seam.
