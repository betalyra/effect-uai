import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Context, Effect, Exit, Schema, Stream } from "effect"
import type * as Items from "../domain/Items.js"
import * as Content from "./Content.js"
import * as Tool from "./Tool.js"

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
      run: ({ to }) => Effect.succeed(to),
    })
    const standard = Tool.make({
      name: "send_email",
      description: "",
      inputSchema: Tool.fromStandardSchema(recipientSchema),
      run: ({ to }) => Effect.succeed(to),
    })
    expectTypeOf(effect).toEqualTypeOf<Tool.Tool<"send_email", { readonly to: string }, string>>()
    expectTypeOf(standard).toEqualTypeOf<Tool.Tool<"send_email", Recipient, string>>()
  })

  it("type: infers Output, Failure, E and R from run and failureSchema", () => {
    class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { to: Schema.String }) {}
    class Mailer extends Context.Service<
      Mailer,
      { readonly send: (to: string) => Effect.Effect<{ readonly id: string }> }
    >()("test/Mailer") {}

    const tool = Tool.make({
      name: "send_email",
      description: "",
      inputSchema: Recipient,
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

  it("type: a Stream run types Output like an Effect run", () => {
    const tool = Tool.make({
      name: "count",
      description: "",
      inputSchema: Tool.noInput,
      run: () => Stream.fromIterable([1, 2, 3]),
    })
    expectTypeOf<Tool.ToolOutput<typeof tool>>().toEqualTypeOf<number>()
  })

  it("type: without outputSchema, run must return a Content.Value", () => {
    Tool.make({
      name: "shot",
      description: "",
      inputSchema: Tool.noInput,
      run: () => Effect.succeed([{ title: "Home" }, Content.image({ _tag: "url", url: "u" })]),
    })
    // @ts-expect-error a Date is not a Content.Value
    Tool.make({
      name: "when",
      description: "",
      inputSchema: Tool.noInput,
      run: () => Effect.succeed(new Date()),
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

  it("renders the same descriptor from an Effect Schema and its fromEffectSchema form", () => {
    const direct = Tool.make({
      name: "send_email",
      description: "Send.",
      inputSchema: Recipient,
      run: () => Effect.succeed("ok"),
      strict: true,
    })
    const wrapped = Tool.make({
      name: "send_email",
      description: "Send.",
      inputSchema: Tool.fromEffectSchema(Recipient),
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

  it.effect("decodes a declared tool's arguments to its typed input", () =>
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
  const weather = Tool.make({
    name: "weather",
    description: "Weather now.",
    inputSchema: Tool.noInput,
    outputSchema: Weather,
    run: () => Effect.succeed({ at: new Date() }),
  })

  it.effect("keeps the descriptor, replaces run and drops the original outputSchema", () =>
    Effect.gen(function* () {
      const mocked = Tool.withRun(weather, () => Effect.succeed("sunny"))
      expect(Tool.toDescriptors([mocked])).toEqual(Tool.toDescriptors([weather]))
      expect(mocked.outputSchema).toBeUndefined()
      expect(yield* Stream.runCollect(Tool.toStream(mocked.run({})))).toEqual(["sunny"])
    }),
  )
})

describe("provider-hosted tools", () => {
  const local = Tool.make({
    name: "send_email",
    description: "",
    inputSchema: Tool.noInput,
    run: () => Effect.succeed("sent"),
  })
  const declared = Tool.declare({ name: "escalate", description: "", inputSchema: Tool.noInput })
  const hosted = Tool.provider({
    name: "web_search",
    description: "",
    inputSchema: Tool.noInput,
    provider: "gemini",
    config: { kind: "google_search" },
  })
  const toolkit = { send_email: local, escalate: declared, web_search: hosted }

  it("are rendered by the provider, never as function descriptors", () => {
    expect(Tool.descriptorsOf(toolkit).map((d) => d.name)).toEqual(["send_email", "escalate"])
    expect(Tool.providerToolsOf(toolkit)).toEqual([hosted])
  })
})
