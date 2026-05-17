---
title: Tools and toolkits
description: Plain and streaming tools, explicit execution, structured results, approval gating, and history reconciliation.
---

Tools are typed Effects your loop decides to run, not callbacks hidden inside
an agent runtime. The model emits `FunctionCall` items; your harness inspects
them, applies any policy, and passes approved calls to `Toolkit.executeAll`.
The executor renders schemas, validates arguments, runs the tool, and turns
success or failure into structured `ToolResult`s. You own `run` and every
policy decision around it.

Two flavors, both dispatched by the same executor:

- **Plain tools** — `run` returns an `Effect<Output>`. The vast majority.
- **Streaming tools** — `run` returns a `Stream<Event>`. Events flow through
  to the consumer in real time; `finalize(events)` reduces them into the
  model-facing `Output`. For sub-agents, progress reporting, and any tool
  whose internal reasoning the user should see live.

## `Tool.make` — plain tools

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

A plain `Tool` is `{ name, description, inputSchema, run, strict? }`.
`run` returns an `Effect`; its requirements flow out via the executor.

`strict` (default `true`) toggles the provider's strict-mode flag
(OpenAI's `strict: true`, Gemini's equivalent). The framework never
rewrites your schema; if the rendered JSON Schema is incompatible with
strict mode, the provider errors and you drop `strict` or simplify it.

## `Tool.streaming` — streaming tools

```ts
import { Stream } from "effect"

const askSubagent = Tool.streaming({
  name: "ask_subagent",
  description: "Ask a specialist sub-agent for help.",
  inputSchema: Tool.fromEffectSchema(SubAgentInput),
  run: ({ question }) => runInner(question), // Stream<TurnEvent>
  finalize: (events): SubAgentOutput => ({
    answer: events
      .filter((e) => e._tag === "TextDelta")
      .map((e) => e.text)
      .join(""),
  }),
  strict: true,
})
```

A `StreamingTool` is `{ name, description, inputSchema, run, finalize, strict? }`.
`run` returns `Stream<Event, unknown, R>`; events flow as
`ToolEvent.Intermediate`s. When the stream ends, `finalize(events)`
reduces them into the `Output` the model sees next turn.

Three canonical `finalize` patterns — text concat, result list, progress +
terminal — sit side-by-side in the
[Streaming tool output recipe](/recipes/streaming-tool-output/).

## `inputSchema` — any Standard Schema

`inputSchema` is `StandardSchemaV1 & StandardJSONSchemaV1`. Zod 4+,
Valibot, and ArkType implement both directly; Effect Schema needs
`Tool.fromEffectSchema` to attach the two extensions.

Two adapters cover the two cases:

- `Tool.fromEffectSchema(schema)` — wrap an Effect Schema so it
  carries the JSON Schema renderer.
- `Tool.fromStandardSchema(schema)` — type-narrowing identity for
  schemas that already implement both Standard interfaces (Zod 4+,
  Valibot, ArkType). Use this so TypeScript pins the inferred input
  type at the tool boundary instead of falling back to `unknown`.

The same schema serves two purposes:

- **Wire rendering** — `Tool.toDescriptors` calls
  `inputSchema.~standard.jsonSchema.input({ target: "draft-2020-12" })`
  to produce the JSON Schema each provider sends.
- **Argument validation** — when a `FunctionCall` arrives, the executor
  parses arguments, validates them, and either passes the parsed value
  to `run` or synthesizes a `Failure(execution_error)`.

## Wiring tools up

For homogeneous plain-tool toolkits, use `Toolkit.make`:

```ts
import * as Toolkit from "@effect-uai/core/Toolkit"

const toolkit = Toolkit.make([getCurrentTime, lookupWeather])
const tools = Toolkit.toDescriptors(toolkit)
```

For mixed plain + streaming tools, use a flat array typed
`ReadonlyArray<Tool.AnyKindTool>` and `Tool.toDescriptors`:

```ts
const allTools: ReadonlyArray<Tool.AnyKindTool> = [
  getCurrentTime, // plain
  askSubagent, // streaming
]
const tools = Tool.toDescriptors(allTools)
```

Both forms produce the provider-agnostic `ToolDescriptor[]` the
generic `LanguageModel` accepts. Providers map `inputSchema` to their
own wire field (`parameters` for OpenAI, `input_schema` for Anthropic).

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

const events = Toolkit.executeAll([lookupWeather, getCoords], calls)
//   ^? Stream<ToolEvent, never, WeatherApiKey | GeoApiKey>

const Live = Layer.mergeAll(
  Layer.succeed(WeatherApiKey, { key: process.env.WEATHER_KEY! }),
  Layer.succeed(GeoApiKey, { key: process.env.GEO_KEY! }),
)

events.pipe(Stream.provide(Live))
```

The compiler enforces that every required service is provided before
the stream runs. Tools that need nothing keep `R = never`.

## `Toolkit.executeAll` — the executor

```ts
import * as Toolkit from "@effect-uai/core/Toolkit"

const events = Toolkit.executeAll(allTools, calls)
//   ^? Stream<ToolEvent>
```

`executeAll` runs every requested tool concurrently and emits a
`Stream<ToolEvent>` in real time. Three event variants:

- **`Intermediate`** — one per element from a streaming tool's `run`.
  Plain tools don't emit any.
- **`Output`** — one per call, terminal. Carries a structured `ToolResult`.
- **`ApprovalRequested`** — emitted by `fromVerdictQueue` for gated calls.

Graceful by default: hallucinated tool names become `Failure(unknown_tool)`
for that call only; runtime errors and validation failures become
`Failure(execution_error)`. Defects flow through the stream's failure
channel. Concurrency defaults to `"unbounded"`; pass `{ concurrency: 4 }`
to bound it.

## `ToolResult` — structured results

The executor speaks in `ToolResult` (structured), not `FunctionCallOutput`
(wire-shaped). Recipes can inspect, redact, audit, or re-route values
before serialization without parse-and-restringify.

```ts
type ToolResult =
  | { _tag: "Value"; call_id: string; tool: string; value: unknown }
  | { _tag: "Failure"; call_id: string; tool: string; kind: string; reason?: string }
```

Synthesizers from `@effect-uai/core/Outcome`: `denied`, `cancelled`,
`executionError`, plus `rejected(call, kind, reason)` for any custom
string kind. The executor doesn't inspect `kind` — it's recipe-level
metadata for audit logs and pattern-matching downstream.

## Wire conversion at the boundary

`Stream<ToolEvent>` carries structured values; `state.history` carries
wire-shaped `FunctionCallOutput`s. The single explicit conversion point
is `toFunctionCallOutput`, applied where results meet history. See the
round-trip below.

## The round-trip shape

The full pattern is in [Basic usage](/recipes/basic-usage/). The body:

```ts
onTurnComplete<State, ToolEvent>((turn) =>
  Effect.sync(() => {
    const calls = Turn.functionCalls(turn)
    // If the model did not ask for tools, this conversation is done.
    if (calls.length === 0) return stop

    return Toolkit.executeAll(allTools, calls).pipe(
      Toolkit.continueWith((results) =>
        // Provider history needs both the function_call items and their outputs.
        Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
      ),
    )
  }),
)
```

`Turn.appendTurn` appends the turn's items (including the `FunctionCall`s
themselves) and then the collected `FunctionCallOutput`s. Both must be
present for the model to see what it asked for _and_ what came back.

## Approval gating

For HITL, `executeAll` stays the only executor. Approval helpers return
plain data the recipe composes explicitly:

```ts
type ToolCallPlan = {
  readonly approved: ReadonlyArray<FunctionCall>
  readonly rejected: ReadonlyArray<ToolResult>
}
```

HTTP/request-shaped flows use `fromApprovalMap(predicate, approvals)(calls)`,
which splits calls into approved and rejected up front:

```ts
const plan = fromApprovalMap(isSensitive, approvals)(calls)
const events = Stream.merge(
  Toolkit.executeAll(allTools, plan.approved),
  Stream.fromIterable(plan.rejected.map((result) => ToolEvent.Output({ result }))),
)
```

Long-lived queue flows use `fromVerdictQueue(predicate, verdicts)(calls)`,
which returns safe calls up front, an `announce` stream of
`ApprovalRequested` events, and a decision stream for gated calls as
verdicts arrive:

```ts
const { approved, decisions, announce } = yield * fromVerdictQueue(isSensitive, verdicts)(calls)

const events = Stream.merge(
  announce,
  Stream.merge(
    Toolkit.executeAll(allTools, approved),
    decisions.pipe(Stream.flatMap(decisionToEvents)),
  ),
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
const reconciled = [...history, ...closures.map(toFunctionCallOutput)]
```

Call these at known transition points; not from inside the loop.

## What's not built in

- **No retry policies** — wrap `tool.run` with `Effect.retry`.
- **No per-tool timeout** — compose with `Effect.timeout`.
- **No magic history reconciliation** — `cancelAllPending` is explicit.

Policy decisions stay in the recipe; the primitives give you the seam.
