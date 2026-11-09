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

Some model-visible tools have **no** local `run`: the loop decides what a call
means (a [declared tool](#declared-tools)), or the provider executes it
(a [provider tool](#provider-hosted-tools)). The executor never pretends to run
them.

## `Tool.make`: defining a tool

```ts
import { Effect, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"

const getCurrentTime = Tool.make({
  name: "get_current_time",
  description: "Look up the current local time for an IANA timezone.",
  inputSchema: Schema.Struct({ timezone: Schema.String }),
  outputSchema: Schema.Struct({ timezone: Schema.String, iso: Schema.String }),
  run: ({ timezone }) => Effect.succeed({ timezone, iso: new Date().toISOString() }),
  strict: true,
})
```

A `Tool` is `{ name, description, inputSchema, outputSchema, failureSchema?,
run, strict? }`. `run` is `(input) => Effect<Output, E, R> | Stream<Output, E,
R>`; `Tool.make` takes the output type from `outputSchema` and infers the error
type `E` and the requirements `R` from the body, and the executor surfaces them
(see [Failures](#failures)). `run` and `outputSchema` are required; a tool
without `run` is [`Tool.declare`](#declared-tools).

`strict` (default `true`) toggles the provider's strict-mode flag
(OpenAI's `strict: true`, Gemini's equivalent). The framework never
rewrites your schema; if the rendered JSON Schema is incompatible with
strict mode, the provider errors and you drop `strict` or simplify it.

### What `run` returns

`run` returns `outputSchema`'s type, and every value is checked and encoded
with it. The encoded side must be JSON: `Schema.Date` is a type error, use
`Schema.DateFromString`. Consumers (`Toolkit.run`, the UI) get the decoded
value back, so a `Date` stays a `Date`.

```ts
const getWeather = Tool.make({
  name: "get_weather",
  description: "The weather right now in a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({ temperatureC: Schema.Number, observedAt: Schema.DateFromString }),
  run: ({ city }) => fetchWeather(city),
})
```

Images and files are classes from `@effect-uai/core/Content`, usable inside
any `outputSchema`. `Content.Value` is the explicit "anything": a string
(text), any JSON value, one image or file, or a top-level array mixing JSON
and media.

```ts
import * as Content from "@effect-uai/core/Content"
import { imageBytes } from "@effect-uai/core/Image"

const screenshot = Tool.make({
  name: "screenshot",
  description: "Take a screenshot of a page.",
  inputSchema: Schema.Struct({ url: Schema.String }),
  outputSchema: Schema.Struct({ title: Schema.String, image: Content.Image }),
  run: ({ url }) =>
    Effect.map(capture(url), (png) => ({
      title: "Home",
      image: Content.image(imageBytes(png, "image/png")),
    })),
})
```

`Content.file(source, filename?)` does the same for PDFs, audio and other
files. Providers that accept media in tool results (Responses, Anthropic,
Gemini) send it natively; text-only APIs (Chat Completions, Mistral, OpenAI
Realtime) fail the request with `AiError.Unsupported`.

## Tool kinds

Every tool is model-visible (it renders a descriptor). Three kinds,
discriminated by `_tag`:

| Constructor     | Executed by                   | Use for                                                   |
| --------------- | ----------------------------- | --------------------------------------------------------- |
| `Tool.make`     | your `run`, via `Toolkit.run` | local tools                                               |
| `Tool.declare`  | the app (no `run`)            | signals and calls answered elsewhere                      |
| `Tool.provider` | the provider                  | provider-hosted web search, code execution, RAG grounding |

### Declared tools

A declared tool has no `run`. It is model-visible and decodable, but the loop
decides what a call means: a **signal** (escalate, finish) or a call
**answered elsewhere** (ask the user, hand off), whose answer the optional
`outputSchema` types.

```ts
const askUser = Tool.declare({
  name: "ask_user",
  description: "Ask the user a question.",
  inputSchema: Schema.Struct({ question: Schema.String }),
  outputSchema: Schema.String,
})
const finish = Tool.declare({
  name: "finish",
  description: "Hand in the report.",
  inputSchema: Schema.Struct({ report: Schema.String }),
})
const toolkit = Toolkit.make(search, askUser, finish)
```

`Toolkit.split(toolkit, turn)` sorts a turn's calls: `run` for `Toolkit.run`,
`declared` decoded and typed per tool, and `invalid` (declared calls with bad
arguments, closed with `InputInvalid` for the model). Handle `declared` with an
exhaustive `Match`, and a new declared tool is a compile error until the loop
handles it:

```ts
onTurnComplete((turn) =>
  Effect.gen(function* () {
    const { run, declared, invalid } = yield* Toolkit.split(toolkit, turn)
    const route = Match.type<Toolkit.DeclaredCall<typeof toolkit>>().pipe(
      Match.discriminatorsExhaustive("tool")({
        ask_user: ({ call, input }) => ..., // input: { question: string }
        finish: ({ input }) => ...,         // input: { report: string }
      }),
    )
    const routes = declared.map(route)
    // run the rest, then next / stop as the routes say
  }),
)
```

Answer a declared call with `Toolkit.complete(toolkit, "ask_user", call,
"Lisbon")`: the success counterpart of `Toolkit.close`, typed by the tool's
`outputSchema`. Both build the outcome `Toolkit.run` would emit, so history and
the UI treat it like any other. A call the app leaves open must be answered
before the next model call (see [History reconciliation](#history-reconciliation)).

If a declared call still reaches `Toolkit.run`, the executor closes it with an
`UnknownTool` failure (`"finish" has no run; the app handles its calls`) rather
than crashing. `Tool.decodeArgs(tool, call)` decodes a single call by hand.

`Tool.provider` carries `provider` and `config` for the provider adapter to
render its hosted tool natively.

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
element reaches the consumer as a `ToolEvent.Partial` as soon as it is
produced; the last is then also the result the model sees. A partial has the tool's own output type, so
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

`wrap` keeps a tool's shape: an `Effect` tool stays single-valued (no partials).

To override or mock a single tool while keeping its model-facing descriptor
identical, spread the record and swap one `run` with `Tool.withRun`. It keeps
the schemas, so the new `run` returns the same output type. On a declared tool
(a spec shared with the browser) it makes a `Tool`:

```ts
const dryRun = {
  ...toolkit,
  send_email: Tool.withRun(toolkit.send_email, ({ to }) =>
    Effect.succeed({ messageId: "dry-run", to }),
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
  outputSchema: WeatherOutput,
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
  outputSchema: Coords,
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

- **`Partial { call_id, tool, value }`**: every element of a `Stream` tool,
  as soon as it is produced (the last one is repeated in the `Output`).
  `Effect` tools produce none.
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
  outputSchema: Weather,
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

For HITL, `run` stays the only executor. `ToolDecision` defines what an answer can
be and groups waiting calls by answer; which calls wait and what each answer
does is app code. `ToolDecision.Default` is approve, or deny with an optional
reason; `ToolDecision.make({...})` defines your own, `ToolDecision.closesWith`
marks an answer that ends the call with an error, and `ToolDecision.byTool` gives
each tool its own set of answers.

HTTP/request-shaped flows get the answers with the next request:

```ts
const { Approve, Deny, unanswered, invalid } = ToolDecision.Default.resolve(
  calls.filter(isSensitive),
  answers,
)
const closed =
  yield *
  Effect.all([
    ...Deny.map(({ call, error }) => close(call, error)), // Deny carries its Denied
    ...[...unanswered, ...invalid.map((i) => i.call)].map((call) =>
      close(call, new ToolOutput.Cancelled({ message: "No answer." })),
    ),
  ])
const run = [...calls.filter((c) => !isSensitive(c)), ...Approve.map((a) => a.call)]
const events = Stream.merge(Toolkit.run(toolkit, run), Stream.fromIterable(closed))
```

`close` is `Toolkit.close(toolkit, call, error)`: an Effect of an `Output`
event with `Result.fail(error)`, so the model sees a closed call like any
failed one. A
sensitive tool declares the errors it may be closed with, so `Toolkit.output`
and `next` encode them like any other failure (core's `Cancelled` is always
possible):

```ts
const sendEmail = Tool.make({ ...spec, failureSchema: ToolDecision.Denied, run })
// a tool you don't define yourself (MCP, a library):
const gated = Tool.withFailures(mcpSendEmail, ToolDecision.Denied)
```

`close` only accepts errors some tool in the toolkit declares, and checks the
call's own tool when it runs: closing a call whose tool doesn't declare the
error fails right there with `UndeclaredFailure`. `Toolkit.withFailures`
declares an error on every tool of a toolkit (e.g. a whole MCP server).

### Handling every answer

A call that is neither run, closed nor kept waiting has no output, and the
next model request fails. `resolve` also returns `answered`, each entry tagged
like its decision, so an exhaustive `Match` makes a forgotten decision a
compile error:

```ts
const { answered, unanswered, invalid } = RefundDecisions.resolve(waiting, answers)
yield *
  Effect.forEach(answered, (entry) =>
    Match.value(entry).pipe(
      Match.tagsExhaustive({
        Approve: ({ call }) => runOne(call),
        Reduce: ({ call, decision }) => runOne(withAmount(call, decision.amount)),
        Deny: ({ call, error }) => Toolkit.close(toolkit, "issue_refund", call, error),
      }),
    ),
  )
```

### Answers per tool

When tools take different answers, `ToolDecision.byTool({ issue_refund: RefundDecisions },
{ fallback: ToolDecision.Default })` resolves each call with its own tool's set and
types `answer(interrupt, decision)` in the browser. Two sets may share a tag
only with exactly the same fields; otherwise it is a compile error (rename
one), since the wire could not tell them apart. Derive the app's gating from
the same map, so a call that waits can always be answered:

```ts
const needsApproval = (call: ToolCall) =>
  Object.hasOwn(Decisions.tools, call.name) || isHelpdeskWrite(call)
```

### Answers that don't fit

`invalid` holds answers a call doesn't take (another tool's decision, wrong
fields, or two different answers to the same call). Keep those calls waiting
and tell the page, for example by sending `run-interrupted` for them again.

### Edited arguments

When an approver changes arguments (a smaller refund, an edited subject),
validate the edit before running, so a bad edit goes back to the approver
instead of reaching the model as `InputInvalid`. The model's `function_call`
keeps its original arguments, so tell it what changed:

```ts
const args = yield * Tool.decodeArgs(issueRefund, call)
const edited = { ...call, arguments: JSON.stringify({ ...args, amount: decision.amount }) }
yield * Tool.decodeArgs(issueRefund, edited) // fails → back to the approver
// after the output:
Items.userText(
  `[approver] issue_refund ${call.call_id}: amount ${args.amount} → ${decision.amount}`,
)
```

`Toolkit.complete(toolkit, "tool", call, value)` does the same for a value the
user supplied, typed by the tool's `outputSchema`. For a long-lived connection, where answers arrive while the run
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
