import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as Items from "../domain/Items.js"
import * as Tool from "./Tool.js"

// ---------------------------------------------------------------------------
// Minimal dual-standard schema for testing — no need to pull Zod / Valibot /
// ArkType as devDeps. This is the smallest possible object satisfying both
// `StandardSchemaV1` and `StandardJSONSchemaV1` per their published specs.
// ---------------------------------------------------------------------------

type EmailRecipient = { readonly to: string }

const emailRecipientSchema: StandardSchemaV1<unknown, EmailRecipient> &
  StandardJSONSchemaV1<unknown, EmailRecipient> = {
  "~standard": {
    version: 1,
    vendor: "test-fixture",
    validate: (value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "to" in value &&
        typeof (value as { to: unknown }).to === "string"
      ) {
        return { value: value as EmailRecipient }
      }
      return { issues: [{ message: "expected { to: string }" }] }
    },
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"],
      }),
      output: () => ({
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"],
      }),
    },
  },
}

// A schema that satisfies StandardSchemaV1 only (no JSON Schema). Used to
// verify the helper's compile-time guard.
const standardOnly: StandardSchemaV1<unknown, EmailRecipient> = {
  "~standard": {
    version: 1,
    vendor: "test-fixture",
    validate: () => ({ value: { to: "" } }),
  },
}

describe("Tool.fromStandardSchema", () => {
  it("returns the schema (structurally) typed as ToolInputSchema<Output>", () => {
    const adapted = Tool.fromStandardSchema(emailRecipientSchema)

    // Same object — helper is a type-narrowing identity at runtime.
    expect(adapted).toBe(emailRecipientSchema)

    // Both interfaces accessible through the same `~standard` key.
    const valid = adapted["~standard"].validate({ to: "hi@example.com" })
    expect(valid).toEqual({ value: { to: "hi@example.com" } })

    const json = adapted["~standard"].jsonSchema.input({ target: "draft-2020-12" })
    expect(json).toEqual({
      type: "object",
      properties: { to: { type: "string" } },
      required: ["to"],
    })
  })

  it("composes with Tool.make so Input is inferred from the schema's Output", async () => {
    const sendEmail = Tool.make({
      name: "send_email",
      description: "Send an email to a single recipient.",
      inputSchema: Tool.fromStandardSchema(emailRecipientSchema),
      run: ({ to }) => Effect.succeed(`queued: ${to}`),
    })

    // `run`'s parameter is typed as { to: string } via the schema's Output —
    // this property access compiles without annotation.
    const result = await Effect.runPromise(sendEmail.run({ to: "x@y.z" }))
    expect(result).toBe("queued: x@y.z")
  })

  it("type: rejects schemas missing the Standard JSON Schema half at compile time", () => {
    // @ts-expect-error — `standardOnly` lacks `jsonSchema`; helper's
    // intersection constraint refuses it.
    Tool.fromStandardSchema(standardOnly)
  })

  it("type: Output type flows through fromStandardSchema into Tool.make", () => {
    const tool = Tool.make({
      name: "send_email",
      description: "send",
      inputSchema: Tool.fromStandardSchema(emailRecipientSchema),
      run: (input) => Effect.succeed(input),
    })

    type InputOf<T> = T extends Tool.Tool<string, infer I, unknown, never> ? I : never
    expectTypeOf<InputOf<typeof tool>>().toEqualTypeOf<EmailRecipient>()
  })
})

describe("Tool.decodeArgs", () => {
  const sendEmail = Tool.make({
    name: "send_email",
    description: "Send an email to a single recipient.",
    inputSchema: Tool.fromStandardSchema(emailRecipientSchema),
    run: ({ to }) => Effect.succeed(`queued: ${to}`),
  })

  const callWith = (args: string): Items.ToolCall => ({
    type: "function_call",
    call_id: "call_1",
    name: "send_email",
    arguments: args,
  })

  it("decodes valid JSON arguments to the typed input", async () => {
    const input = await Effect.runPromise(Tool.decodeArgs(sendEmail, callWith('{"to":"x@y.z"}')))
    expect(input).toEqual({ to: "x@y.z" })
    // The return type is the tool's Input, no annotation needed.
    expectTypeOf(input).toEqualTypeOf<EmailRecipient>()
  })

  it("fails with ToolError when the arguments aren't valid JSON", async () => {
    const exit = await Effect.runPromiseExit(Tool.decodeArgs(sendEmail, callWith("not json")))
    expect(exit._tag).toBe("Failure")
  })

  it("fails with ToolError when the arguments don't satisfy the schema", async () => {
    const exit = await Effect.runPromiseExit(Tool.decodeArgs(sendEmail, callWith('{"to":42}')))
    expect(exit._tag).toBe("Failure")
  })
})
