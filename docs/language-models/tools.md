---
title: Tools and toolkits
description: Defining tools, returning text, JSON, images and files, streaming partial results, toolkits, explicit execution, typed failures, approval gating, and history reconciliation.
---

Tools are typed Effects your loop decides to run, not callbacks hidden inside
an agent runtime. The model emits `ToolCall` items; your harness inspects
them, applies any policy, and passes approved calls to `Toolkit.run`.
The executor renders schemas, validates arguments, runs the tool, and reports
each call's outcome as a typed `Result`: the tool's value, or an error the
model may see. You own `run` and every policy decision around it.

Most tools have a local `run`: it takes the decoded input and returns an
`Effect` with the model-facing value, or a `Stream` whose elements reach the
consumer in real time as partial results (sub-agent text, download progress)
and whose last element is the value the model sees. `Tool.make` builds these.

Some model-visible tools have **no** local `run`: they are executed by the
provider, or the loop decides what a call means. Those are the other two
[tool kinds](#tool-kinds) (`Tool.provider`, `Tool.declare`); the executor
reports them as `UnknownTool` rather than pretending to run a fake handler.

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
  inputSchema: GetCurrentTimeInput,
  run: ({ timezone }) => Effect.succeed({ timezone, iso: new Date().toISOString() }),
  strict: true,
})
```

A `Tool` is `{ name, description, inputSchema, outputSchema?, failureSchema?,
run, strict? }`. `run` is `(input) => Effect<Output, E, R> | Stream<Output, E,
R>`; `Tool.make` infers the output, the error type `E` and the requirements
`R` from the body, and the executor surfaces them (see [Failures](#failures)).

`strict` (default `true`) toggles the provider's strict-mode flag
(OpenAI's `strict: true`, Gemini's equivalent). The framework never
rewrites your schema; if the rendered JSON Schema is incompatible with
strict mode, the provider errors and you drop `strict` or simplify it.

### What `run` returns

**Without `outputSchema`**, `run` returns a `Content.Value`: a string (text),
any JSON value, one image or file, or a top-level array mixing JSON and media.
Anything else (a `Date`, a class instance, an object with an `undefined`
field) is a type error; omit optional keys instead of setting them to
`undefined`.

Images and files are classes from `@effect-uai/core/Content`:

```ts
import * as Content from "@effect-uai/core/Content"
import { imageBytes } from "@effect-uai/core/Image"

const screenshot = Tool.make({
  name: "screenshot",
  description: "Take a screenshot of a page.",
  inputSchema: Schema.Struct({ url: Schema.String }),
  run: ({ url }) =>
    Effect.map(capture(url), (png) => [
      { url, title: "Home" },
      Content.image(imageBytes(png, "image/png")),
    ]),
})
```

`Content.file(source, filename?)` does the same for PDFs, audio and other
files. Providers that accept media in tool results (Responses, Anthropic,
Gemini) send it natively; text-only APIs (Chat Completions, Mistral, OpenAI
Realtime) fail the request with `AiError.Unsupported`.

**With `outputSchema`**, `run` returns the schema's type, and every value is
checked and encoded with it. The encoded side must be JSON: `Schema.Date` is a
type error, use `Schema.DateFromString`. Consumers (`Toolkit.run`, the UI) get
the decoded value back, so a `Date` stays a `Date`.

```ts
const WeatherOutput = Schema.Struct({
  temperatureC: Schema.Number,
  observedAt: Schema.DateFromString,
})

const getWeather = Tool.make({
  name: "get_weather",
  description: "The weather right now in a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: WeatherOutput,
  run: ({ city }) => fetchWeather(city),
})
```

## Tool kinds

Every tool is model-visible (it renders a descriptor), but only `Tool.make`
tools are locally executable. The three kinds, discriminated by `_tag`:

| Constructor     | Executed by                                   | Use for                                                   |
| --------------- | --------------------------------------------- | --------------------------------------------------------- |
| `Tool.make`     | your `run`, via `Toolkit.run`                 | ordinary local tools (weather, send email)                |
| `Tool.provider` | the provider                                  | provider-hosted web search, code execution, RAG grounding |
| `Tool.declare`  | nobody (the loop decides what the call means) | escalate, pause, ask the user, hand off                   |

A `Tool.declare` tool carries a `name`, `description`, and `inputSchema` but
no `run`. You decode the arguments with `Tool.decodeArgs(tool, call)` and act
on them (advance a tier, schedule a wake-up, stop for input) where the loop
handles the call, instead of running a handler:

```ts
const escalate = Tool.declare({
  name: "escalate",
  description: "Hand the question to a stronger model.",
  inputSchema: EscalateInput,
})

// in onTurnComplete:
const call = Turn.getToolCalls(turn).find((c) => c.name === "escalate")
if (call !== undefined) {
  return Tool.decodeArgs(escalate, call).pipe(Effect.map((args) => next({ tier: 1, ...args })))
}
```

If a declared or provider tool is ever passed to `Toolkit.run` (the loop
forgot to intercept it), the executor closes that call with an `UnknownTool`
failure rather than crashing, the same as a tool name that doesn't exist.

`Tool.provider` additionally carries `provider` and `config` for the provider
adapter to render its hosted tool natively.

### Provider-hosted tools

Web search, code execution, and file grounding run on the provider's side. Each
provider gives you typed constructors for the tools it hosts; drop them into a
toolkit next to your own `Tool.make` tools and the model uses them to produce
grounded answers. You never write a `run` for them, and the loop won't try to
execute them locally.

```ts
import { Gemini } from "@effect-uai/google"
import { Anthropic } from "@effect-uai/anthropic"
import { Responses } from "@effect-uai/responses"

// Gemini: Google Search grounding, URL context, code execution.
const geminiToolkit = { search: Gemini.googleSearchTool, get_weather: weatherTool }

// Anthropic: hosted web search (with options) and code execution.
const anthropicToolkit = {
  search: Anthropic.webSearchTool({ maxUses: 5, allowedDomains: ["docs.anthropic.com"] }),
  run: Anthropic.codeExecutionTool,
}

// OpenAI Responses: web search, code interpreter, file search.
const openaiToolkit = {
  search: Responses.webSearchTool({ searchContextSize: "high" }),
  files: Responses.fileSearchTool({ vectorStoreIds: ["vs_123"] }),
}
```

A hosted tool only works with the provider that hosts it: hand a Gemini tool to
the Anthropic model and the request fails fast with `AiError.Unsupported`.

## Streaming tools: return a `Stream`

A tool that has something to show while it works returns a `Stream`. Every
element but the last reaches the consumer as a `ToolEvent.Partial`; the last
is the result the model sees. A partial has the tool's own output type, so
make progress part of that type, and a UI renders partials and the result
with the same schema:

```ts
import { Stream } from "effect"

const askSubagent = Tool.make({
  name: "ask_subagent",
  description: "Ask a specialist sub-agent for help.",
  inputSchema: SubAgentInput,
  outputSchema: Schema.Struct({ answer: Schema.String }),
  // The answer so far, one snapshot per text delta; the last is the full answer.
  run: ({ question }) =>
    runInner(question).pipe(
      Turn.textDeltas,
      Stream.scan(
        () => "",
        (answer, text: string) => answer + text,
      ),
      Stream.map((answer) => ({ answer })),
    ),
  strict: true,
})
```

A `Stream` tool that emits nothing ends with an `OutputInvalid` failure. More
patterns (sub-agent text, progress then a completed value) sit side-by-side in
the [Streaming tool output recipe](/recipes/streaming-tool-output/).

## `inputSchema`: any Standard Schema

`inputSchema` takes an Effect Schema directly, or any schema implementing
`StandardSchemaV1 & StandardJSONSchemaV1`. Zod 4+, Valibot, and ArkType
implement both.

Two adapters cover the explicit cases:

- `Tool.fromEffectSchema(schema)`: wrap an Effect Schema so it
  carries the JSON Schema renderer (`Tool.make` does this for you).
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
  to `run` or closes the call with an `InputInvalid` failure.

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
runtime-built array (e.g. [MCP](/language-models/mcp/)), where names are trusted and last-wins. The rendered descriptors are the
provider-agnostic `ToolDescriptor[]` the generic `LanguageModel` accepts;
providers map `inputSchema` to their own wire field (`parameters` for OpenAI,
`input_schema` for Anthropic).

### Composing toolkits

Combine independently-built toolkits (built-ins, [MCP servers](/language-models/mcp/), declared tools) with
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
provider and declared tools untouched. The middleware sees `run` as a stream
(an `Effect` tool is a one-element stream) and returns one. It tracks the
middleware's added requirement `R2`, unioning it into the toolkit's
requirements:

```ts
const logging: Toolkit.Middleware = (run, name) => (input) =>
  Stream.unwrap(Effect.as(Effect.logInfo(`tool:${name}`), run(input)))

const observed = pipe(toolkit, Toolkit.wrap(logging), Toolkit.wrap(withAuthz))
```

To override or mock a single tool while keeping its model-facing descriptor
identical, spread the record and swap one `run` with `Tool.withRun`. It drops
`outputSchema` (that described the original `run`), so the new `run` returns a
`Content.Value`:

```ts
const dryRun = {
  ...toolkit,
  send_email: Tool.withRun(toolkit.send_email, ({ to }) =>
    Effect.succeed({ status: "dry-run", to }),
  ),
}
```

### Tools with service requirements

A tool's `run` is just an `Effect` (or `Stream`), so it can declare service
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
  inputSchema: LookupWeatherInput,
  run: ({ city }) =>
    Effect.gen(function* () {
      const { key } = yield* WeatherApiKey
      return yield* fetchWeather(key, city)
    }),
})

const getCoords = Tool.make({
  name: "get_coords",
  description: "Coordinates for a place.",
  inputSchema: GetCoordsInput,
  run: ({ place }) =>
    Effect.gen(function* () {
      const { key } = yield* GeoApiKey
      return yield* fetchCoords(key, place)
    }),
})

const events = Toolkit.run(Toolkit.make(lookupWeather, getCoords), calls)
//   ^? Stream<Toolkit.Event<...>, never, WeatherApiKey | GeoApiKey>

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
//   ^? Stream<Toolkit.Event<typeof toolkit>, Toolkit.ToolkitE<typeof toolkit>, ...>
```

`run` takes a `Toolkit`, dispatches each call by name (O(1)), runs every
requested tool concurrently, and emits events in real time. Two event
variants, typed per tool:

- **`Partial { call_id, tool, value }`**: every element but the last of a
  `Stream` tool. `Effect` tools produce none.
- **`Output { call_id, tool, result }`**: one per call, terminal. `result` is
  Effect's `Result`: `Success` with the tool's value, or `Failure` with an
  error the model sees.

Graceful by default: a hallucinated tool name (or a declared or provider tool)
becomes an `UnknownTool` failure for that call only; arguments that fail the
schema become `InputInvalid`, and a value `outputSchema` rejects becomes
`OutputInvalid`. These are tagged errors from `@effect-uai/core/ToolOutput`.
Errors the tool did not declare fail the stream instead (see
[Failures](#failures)). Concurrency defaults to `"unbounded"`; pass
`{ concurrency: 4 }` to bound it.

## Outcomes

`tool` is the discriminant, so checking it narrows `value` and `result` to
that tool's types. Values are decoded: a `Date` from `Schema.DateFromString`
stays a `Date`.

```ts
Toolkit.run(toolkit, calls).pipe(
  Stream.filter(Toolkit.isOutcome),
  Stream.runForEach((e) =>
    e.tool === "get_weather"
      ? Result.match(e.result, {
          onSuccess: (weather) => Effect.log(weather.observedAt.toISOString()),
          onFailure: (error) => Effect.log(error._tag),
        })
      : Effect.void,
  ),
)
```

`Toolkit.isOutcome` narrows to the `Output` members, also in a loop's mixed
stream. On an event not narrowed by `tool`, `result` is a union of per-tool
`Result`s, which `Result.match` does not accept: check `result._tag` there.

## Failures

A tool's `run` fails through its typed error channel `E`. The executor splits
those failures two ways, and this is the one rule to internalize:

- **Declared** (the model sees it and can adapt): an error matching the tool's
  `failureSchema`. It becomes the call's `Failure` and the run continues.
- **Undeclared** (the loop's decision): every other error fails
  `Toolkit.run`'s stream, typed as `Toolkit.ToolkitE<T>`, so you `catchTag` a
  specific tool error or let it end the run. Defects die.

```ts
class CityNotFound extends Schema.TaggedError<CityNotFound>()("CityNotFound", {
  city: Schema.String,
}) {}

const getWeather = Tool.make({
  name: "get_weather",
  description: "The weather right now in a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  failureSchema: CityNotFound,
  run: ({ city }) =>
    lookup(city).pipe(
      Effect.flatMap((found) =>
        found === undefined ? Effect.fail(new CityNotFound({ city })) : Effect.succeed(found),
      ),
    ),
})
```

For a one-off message, list the ready-made `Tool.ToolFailed` in `failureSchema`
and fail with `Tool.fail("page not found")`.

To make a whole toolkit's failures model-visible in one line,
`Toolkit.describeFailures(toolkit, describe)` turns every undeclared error into
a `ToolFailed` with the message `describe` returns; declared errors pass
through. Group tools by recovery policy, wrap each group, then compose:

```ts
const kit =
  yield *
  Toolkit.compose(
    Toolkit.describeFailures(searchKit, AiError.describe), // search failures reach the model
    browserToolkit(session), // browser failures stay typed and can end the run
  )
```

Return `undefined` from `describe` to keep an error fatal:

```ts
Toolkit.describeFailures(toolkit, (e: BrowserError) =>
  e._tag === "BrowserSessionExpired" ? undefined : BrowserError.describe(e),
)
```

Because an undeclared failure can leave sibling calls in a concurrent batch
unanswered, a loop that catches and continues must reconcile history first with
`HistoryCheck.cancelAllPending` before the next provider request.

## Outcomes in history

`Stream<ToolEvent>` carries decoded values; `state.history` carries
`ToolCallOutput`s. `Toolkit.output(toolkit, event)` encodes an outcome with the
tool's schemas into history parts (an Effect): a string becomes `input_text`,
an image or file its own part, an array with media one part per element, and
anything else one `input_json` value. A failure is the encoded error, flagged
`isError`. The provider codec serializes the parts.

```ts
const outputs =
  yield *
  Toolkit.run(toolkit, calls).pipe(
    Stream.filter(Toolkit.isOutcome),
    Stream.mapEffect(Toolkit.output(toolkit)),
    Stream.runCollect,
  )
```

`Toolkit.decode(toolkit, name, item)` reads a history item back as a typed
`Result`. The loop helpers below do the encoding for you.

## The round-trip shape

The full pattern is in [Basic usage](/recipes/basic-usage/). The body:

```ts
onTurnComplete((turn) =>
  Effect.sync(() => {
    const calls = Turn.getToolCalls(turn)
    // If the model did not ask for tools, this conversation is done.
    if (calls.length === 0) return stop()

    // Forward the tool events, then continue with the turn and its outputs appended.
    return Toolkit.run(toolkit, calls).pipe(Toolkit.next(toolkit, state, turn))
  }),
)
```

`Toolkit.next` appends the turn's items (including the `ToolCall`s
themselves) and then each outcome encoded with `Toolkit.output`. Both must be
present for the model to see what it asked for _and_ what came back.

For a custom state, use the two halves: `Toolkit.continueWith(build)` forwards
every event, then continues with `build(outcomes)` (an Effect), and
`Toolkit.appendResults(toolkit, state, turn)` is the `build` that `next` uses:

```ts
Toolkit.run(toolkit, calls).pipe(
  Toolkit.continueWith((outcomes) =>
    Toolkit.appendResults(toolkit, { ...state, trail: trailOf(outcomes) }, turn)(outcomes),
  ),
)
```

## Approval gating

For HITL, `run` stays the only executor. `Approval` defines what an answer can
be and groups waiting calls by answer. `Approval.Default` is approve, or deny
with an optional reason; `Approval.decisions({...})` defines your own.

HTTP/request-shaped flows get the answers with the next request:

```ts
const { Approve, Deny, unanswered } = Approval.Default.resolve(calls.filter(isSensitive), answers)
const closed = [
  ...Deny.map(({ call, decision }) =>
    close(call, new Approval.Denied({ message: decision.reason ?? "Denied by the user." })),
  ),
  ...unanswered.map((call) => close(call, new ToolOutput.Cancelled({ message: "No answer." }))),
]
const run = [...calls.filter((c) => !isSensitive(c)), ...Approve.map((a) => a.call)]
const events = Stream.merge(Toolkit.run(toolkit, run), Stream.fromIterable(closed))
```

`close` builds a `ToolEvent.Output` with `Result.fail(error)`, so the model
sees a closed call like any failed one. Those errors aren't in the tool's
`failureSchema`, so encode them for history with your own schema:

```ts
const Closings = Schema.Union([Approval.Denied, ToolOutput.Cancelled])
const item = yield * ToolOutput.failure(call, Closings, new Approval.Denied({ message: "Not now" }))
```

`ToolOutput.success(call, outputSchema, value)` does the same for a value the
user supplied. For a long-lived connection, where answers arrive while the run
waits, the [Tool call approval recipe](/recipes/tool-call-approval/) has a
copyable answer-queue version, `fromQueue`, with a timeout.

Either way, every model-requested call receives a matching tool result
in history.

## History reconciliation

Every provider rejects a new request if any prior `function_call`
lacks a matching `function_call_output`. Flows that can be interrupted,
restarted, or branched (HITL, mid-stream abort, checkpoints, stateless
HTTP servers) need to detect orphans and close them before submitting:

```ts
import * as HistoryCheck from "@effect-uai/core/HistoryCheck"

const closures = yield * HistoryCheck.cancelAllPending(history, "user moved on")
const reconciled = [...history, ...closures]
```

`cancelAllPending` returns a ready-to-append `ToolCallOutput` with a
`Cancelled` error for each unanswered call; `findUnansweredCalls` and
`isReconciled` are there for your own closing. Call these at known transition
points, not from inside the loop.

## What's not built in

- **No retry policies**: wrap `tool.run` with `Effect.retry`.
- **No per-tool timeout**: compose with `Effect.timeout`.
- **No magic history reconciliation**: `cancelAllPending` is explicit.

Policy decisions stay in the recipe; the primitives give you the seam.
