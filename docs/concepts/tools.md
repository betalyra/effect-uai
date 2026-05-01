---
title: Tools and toolkits
description: Define a tool with a Standard Schema input, group tools into a toolkit, and round-trip results back to the model.
---

A tool is a typed function the model can request. The framework owns
three jobs: render the tool's schema to the provider's wire format,
validate incoming arguments, and translate failures back into something
the model can read on the next turn. You own the `run` function.

## `Tool.make`

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
  run: ({ timezone }) =>
    Effect.succeed({ timezone, iso: new Date().toISOString() }),
  strict: true,
})
```

A `Tool` is `{ name, description, inputSchema, run, strict? }`. The
`run` function returns an `Effect`; whatever requirements it has flow
through to `Toolkit.executeAll` and out via `ToolsR<typeof toolkit>`.

`strict` (default `true`) controls whether the provider renders the
tool with its strict-mode flag (OpenAI's `strict: true`, etc). The
framework never rewrites your schema; if the rendered JSON Schema is
incompatible with strict mode, the provider returns an error and you
either drop `strict` or simplify the schema.

## `inputSchema` - any Standard Schema

`inputSchema` is `StandardSchemaV1 & StandardJSONSchemaV1`: any library
that implements both interfaces works directly. That includes Zod 4+,
Valibot, and ArkType. Effect Schema needs `Tool.fromEffectSchema` to
attach the two extensions.

The same schema is used for two things:

- **Wire rendering**: `Toolkit.toDescriptors` calls
  `inputSchema.~standard.jsonSchema.input({ target: "draft-2020-12" })`
  to produce the JSON Schema each provider sends.
- **Argument validation**: when the model returns a `FunctionCall`,
  `Tool.execute` parses the arguments string as JSON, runs the schema's
  `validate`, and either passes the parsed value to `run` or surfaces
  a `ToolError`.

## `Toolkit.make`

A toolkit groups tools into one collection so the loop can find them
by name and the provider can render them all at once.

```ts
import * as Toolkit from "@effect-uai/core/Toolkit"

const toolkit = Toolkit.make([getCurrentTime, lookupWeather, sendEmail])
const tools = Toolkit.toDescriptors(toolkit)  // pass to streamTurn options
```

`toDescriptors` produces the provider-agnostic `ToolDescriptor[]` the
generic `LanguageModel` accepts. Each provider maps `inputSchema` onto
its own wire field (`parameters` for OpenAI, `input_schema` for
Anthropic, `parameters` again for Gemini).

## Executing a turn's calls

After a turn completes, the assistant may have emitted any number of
`FunctionCall`s. `Turn.functionCalls(turn)` extracts them; the toolkit
runs them:

```ts
const calls = Turn.functionCalls(turn)
const outputs = yield* Toolkit.executeAllSafe(toolkit, calls)
```

Two execution modes:

- **`executeAll(toolkit, calls)`** - any `ToolError` short-circuits the
  Effect with the failure. Use when bad arguments should abort the loop.
- **`executeAllSafe(toolkit, calls, onError?)`** - per-call `ToolError`s
  are caught and translated into `FunctionCallOutput`s carrying a
  structured JSON error, so the model can self-correct on the next turn.
  This is the default for a robust agent loop. The default `onError`
  (`Toolkit.defaultRepair`) emits
  `{ error: "argument_validation_failed", tool, message }`.

Both run with `concurrency: "unbounded"` by default; pass
`{ concurrency: 4 }` to bound parallelism.

Defects (e.g. unknown tool name) are *never* caught by `executeAllSafe`.
Those are programming errors, not model errors.

## The round-trip shape

The full pattern is in [Basic usage](/recipes/basic-usage/). The shape
of the loop body:

```ts
streamUntilComplete((turn) =>
  Effect.gen(function* () {
    const next = Turn.cursor(state, turn)
    const calls = Turn.functionCalls(turn)

    if (calls.length === 0) return stop

    const outputs = yield* Toolkit.executeAllSafe(toolkit, calls)
    return nextAfter(Stream.fromIterable(outputs), {
      ...next,
      history: [...next.history, ...outputs],
    })
  }),
)
```

`Turn.cursor` extends history with the turn's items (including the
`FunctionCall`s themselves), then the loop appends the
`FunctionCallOutput`s. Both must be present for the model to see what
it asked for *and* what came back.

## What's not built in

- **No retry policies for tool execution.** Wrap `tool.run` with
  `Effect.retry` if you want them.
- **No timeout per tool.** Compose with `Effect.timeout`.
- **No "approve before running" gate.** Inspect calls in the loop
  body, prompt the user, then execute (or skip) by hand.

These are policy decisions, and the loop primitive gives you the seam
to plug them in without forking the framework.
