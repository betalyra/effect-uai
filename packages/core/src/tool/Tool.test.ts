import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Context, Effect, Exit, Result, Schema, Stream } from "effect"
import type * as Items from "../domain/Items.js"
import * as Content from "./Content.js"
import * as Tool from "./Tool.js"
import * as Toolkit from "./Toolkit.js"

// The smallest object satisfying both Standard Schema and Standard JSON Schema.
type Recipient = { readonly to: string }

const recipientSchema: StandardSchemaV1<unknown, Recipient> &
  StandardJSONSchemaV1<unknown, Recipient> = {
  "~standard": {
    version: 1,
    vendor: "test-fixture",
    validate: (value) =>
      typeof value === "object" && value !== null && "to" in value && typeof value.to === "string"
        ? { value: { to: value.to } }
        : { issues: [{ message: "expected { to: string }" }] },
    jsonSchema: {
      input: () => ({ type: "object", properties: { to: { type: "string" } }, required: ["to"] }),
      output: () => ({ type: "object", properties: { to: { type: "string" } }, required: ["to"] }),
    },
  },
}

const callWith = (name: string, args: string): Items.ToolCall => ({
  type: "function_call",
  call_id: "call_1",
  name,
  arguments: args,
})

describe("Tool.make", () => {
  const Recipient = Schema.Struct({ to: Schema.String })

  it("type: infers Input from an Effect Schema or a Standard Schema, and keeps the name literal", () => {
    const effect = Tool.make({
      name: "send_email",
      description: "",
      inputSchema: Recipient,
      outputSchema: Schema.String,
      run: ({ to }) => Effect.succeed(to),
    })
    const standard = Tool.make({
      name: "send_email",
      description: "",
      inputSchema: Tool.fromStandardSchema(recipientSchema),
      outputSchema: Schema.String,
      run: ({ to }) => Effect.succeed(to),
    })
    expectTypeOf(effect).toEqualTypeOf<Tool.Tool<"send_email", { readonly to: string }, string>>()
    expectTypeOf(standard).toEqualTypeOf<Tool.Tool<"send_email", Recipient, string>>()
  })

  it("type: Output from outputSchema; Failure, E and R from failureSchema and run", () => {
    class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { to: Schema.String }) {}
    class Mailer extends Context.Service<
      Mailer,
      { readonly send: (to: string) => Effect.Effect<{ readonly id: string }> }
    >()("test/Mailer") {}

    const tool = Tool.make({
      name: "send_email",
      description: "",
      inputSchema: Recipient,
      outputSchema: Schema.Struct({ id: Schema.String }),
      failureSchema: NotFound,
      run: ({ to }) =>
        Effect.gen(function* () {
          if (to === "") return yield* new NotFound({ to })
          if (to === "boom") return yield* Effect.fail("crashed" as const)
          return yield* (yield* Mailer).send(to)
        }),
    })
    expectTypeOf<Tool.ToolOutput<typeof tool>>().toEqualTypeOf<{ readonly id: string }>()
    expectTypeOf<Tool.ToolFailure<typeof tool>>().toEqualTypeOf<NotFound>()
    expectTypeOf<Tool.ToolUnhandled<typeof tool>>().toEqualTypeOf<"crashed">()
    expectTypeOf<Tool.ToolR<typeof tool>>().toEqualTypeOf<Mailer>()
  })

  it("type: a Stream run returns outputSchema's type like an Effect run", () => {
    const tool = Tool.make({
      name: "count",
      description: "",
      inputSchema: Tool.noInput,
      outputSchema: Schema.Number,
      run: () => Stream.fromIterable([1, 2, 3]),
    })
    expectTypeOf<Tool.ToolOutput<typeof tool>>().toEqualTypeOf<number>()
  })

  it("type: a tool with run declares outputSchema; Content.Value is the explicit anything", () => {
    Tool.make({
      name: "shot",
      description: "",
      inputSchema: Tool.noInput,
      outputSchema: Content.Value,
      run: () => Effect.succeed([{ title: "Home" }, Content.image({ _tag: "url", url: "u" })]),
    })
    // @ts-expect-error a tool with run needs an outputSchema
    Tool.make({
      name: "shot",
      description: "",
      inputSchema: Tool.noInput,
      run: () => Effect.succeed("ok"),
    })
  })

  it("type: with outputSchema, the encoded side must be JSON", () => {
    const Observed = Schema.Struct({ at: Schema.DateFromString })
    const tool = Tool.make({
      name: "when",
      description: "",
      inputSchema: Tool.noInput,
      outputSchema: Observed,
      run: () => Effect.succeed({ at: new Date() }),
    })
    expectTypeOf<Tool.ToolOutput<typeof tool>>().toEqualTypeOf<{ readonly at: Date }>()

    Tool.make({
      name: "when",
      description: "",
      inputSchema: Tool.noInput,
      // @ts-expect-error Schema.Date encodes to a Date, not JSON
      outputSchema: Schema.Struct({ at: Schema.Date }),
      run: () => Effect.succeed({ at: new Date() }),
    })
  })

  it("type: make requires run", () => {
    // @ts-expect-error run is missing: a tool without run is Tool.declare
    Tool.make({
      name: "escalate",
      description: "",
      inputSchema: Tool.noInput,
      outputSchema: Schema.String,
    })
  })

  it("type: a declared tool is a signal, or a call answered elsewhere typed by outputSchema", () => {
    const escalate = Tool.declare({
      name: "escalate",
      description: "",
      inputSchema: Schema.Struct({ reason: Schema.String }),
    })
    const askUser = Tool.declare({
      name: "ask_user",
      description: "",
      inputSchema: Schema.Struct({ question: Schema.String }),
      outputSchema: Schema.Struct({ answer: Schema.String }),
    })
    expect(escalate._tag).toBe("DeclaredTool")
    expectTypeOf<Tool.ToolOutput<typeof escalate>>().toEqualTypeOf<never>()
    expectTypeOf<Tool.ToolOutput<typeof askUser>>().toEqualTypeOf<{ readonly answer: string }>()
  })

  it("renders the same descriptor from an Effect Schema and its fromEffectSchema form", () => {
    const direct = Tool.make({
      name: "send_email",
      description: "Send.",
      inputSchema: Recipient,
      outputSchema: Schema.String,
      run: () => Effect.succeed("ok"),
      strict: true,
    })
    const wrapped = Tool.make({
      name: "send_email",
      description: "Send.",
      inputSchema: Tool.fromEffectSchema(Recipient),
      outputSchema: Schema.String,
      run: () => Effect.succeed("ok"),
      strict: true,
    })
    expect(Tool.toDescriptors([direct])).toEqual(Tool.toDescriptors([wrapped]))
    expect(Tool.toDescriptors([direct])[0]).toMatchObject({
      inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      strict: true,
    })
  })
})

describe("Tool.decodeArgs", () => {
  const escalate = Tool.declare({
    name: "escalate",
    description: "Escalate to a human.",
    inputSchema: Schema.Struct({ reason: Schema.String }),
  })

  it.effect("decodes the arguments of a tool without run to its typed input", () =>
    Effect.gen(function* () {
      const input = yield* Tool.decodeArgs(escalate, callWith("escalate", '{"reason":"stuck"}'))
      expect(input).toEqual({ reason: "stuck" })
      expectTypeOf(input).toEqualTypeOf<{ readonly reason: string }>()
    }),
  )

  it.effect("tells bad JSON (ToolError) apart from a schema violation (ToolValidationError)", () =>
    Effect.gen(function* () {
      const notJson = yield* Effect.flip(Tool.decodeArgs(escalate, callWith("escalate", "nope")))
      const invalid = yield* Effect.flip(
        Tool.decodeArgs(escalate, callWith("escalate", '{"reason":1}')),
      )
      expect(notJson._tag).toBe("ToolError")
      expect(invalid._tag).toBe("ToolValidationError")
    }),
  )

  it.effect("fails, rather than throws, when a Standard Schema validator throws", () =>
    Effect.gen(function* () {
      const throwing = Tool.declare({
        name: "t",
        description: "",
        inputSchema: {
          "~standard": {
            ...recipientSchema["~standard"],
            validate: () => {
              throw new Error("bug")
            },
          },
        },
      })
      const exit = yield* Effect.exit(Tool.decodeArgs(throwing, callWith("t", "{}")))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe("Tool.withRun", () => {
  const Weather = Schema.Struct({ at: Schema.DateFromString })
  const at = new Date("2026-01-01T00:00:00.000Z")
  const weather = Tool.make({
    name: "weather",
    description: "Weather now.",
    inputSchema: Tool.noInput,
    outputSchema: Weather,
    run: () => Effect.succeed({ at: new Date() }),
  })

  it.effect("keeps the descriptor and schemas, replaces run", () =>
    Effect.gen(function* () {
      const mocked = Tool.withRun(weather, () => Effect.succeed({ at }))
      expect(Tool.toDescriptors([mocked])).toEqual(Tool.toDescriptors([weather]))
      expect(mocked.outputSchema).toBe(Weather)
      expect(yield* Stream.runCollect(Tool.toStream(mocked.run({})))).toEqual([{ at }])
    }),
  )

  it("type: the new run returns the same output type", () => {
    // @ts-expect-error a string is not the tool's output
    Tool.withRun(weather, () => Effect.succeed("sunny"))
  })

  it.effect("implements a declared tool, keeping its schemas", () =>
    Effect.gen(function* () {
      const spec = Tool.declare({
        name: "weather",
        description: "Weather now.",
        inputSchema: Tool.noInput,
        outputSchema: Weather,
      })
      const implemented = Tool.withRun(spec, () => Effect.succeed({ at }))
      expect(implemented._tag).toBe("LocalTool")
      expect(implemented.outputSchema).toBe(Weather)
      const events = yield* Stream.runCollect(
        Toolkit.run(Toolkit.make(implemented), [callWith("weather", "{}")]),
      )
      expect(events.map((e) => e._tag === "Output" && e.result)).toEqual([Result.succeed({ at })])
    }),
  )

  it("type: withFailures keeps the tool's kind", () => {
    const declared = Tool.withFailures(
      Tool.declare({ name: "a", description: "", inputSchema: Tool.noInput }),
      Tool.ToolFailed,
    )
    const local = Tool.withFailures(weather, Tool.ToolFailed)
    expectTypeOf(declared._tag).toEqualTypeOf<"DeclaredTool">()
    expectTypeOf(local._tag).toEqualTypeOf<"LocalTool">()
    expectTypeOf<Tool.ToolFailure<typeof local>>().toEqualTypeOf<Tool.ToolFailed>()
  })
})

describe("provider-hosted tools", () => {
  const local = Tool.make({
    name: "send_email",
    description: "",
    inputSchema: Tool.noInput,
    outputSchema: Schema.String,
    run: () => Effect.succeed("sent"),
  })
  const signal = Tool.declare({ name: "escalate", description: "", inputSchema: Tool.noInput })
  const hosted = Tool.provider({
    name: "web_search",
    description: "",
    inputSchema: Tool.noInput,
    provider: "gemini",
    config: { kind: "google_search" },
  })
  const toolkit = { send_email: local, escalate: signal, web_search: hosted }

  it("are rendered by the provider, never as function descriptors", () => {
    expect(Tool.descriptorsOf(toolkit).map((d) => d.name)).toEqual(["send_email", "escalate"])
    expect(Tool.providerToolsOf(toolkit)).toEqual([hosted])
  })
})
