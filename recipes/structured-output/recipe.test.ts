import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import type * as Turn from "@effect-uai/core/Turn"
import { structuredRecipe } from "./recipe.js"

const answering = (text: string): Turn.Turn => ({
  stop_reason: "stop",
  usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
})

const run = (text: string) =>
  Effect.runPromiseExit(
    structuredRecipe("mock").pipe(Effect.provide(MockProvider.layer([answering(text)]))),
  )

describe("structured-output", () => {
  it("folds the event stream into a Turn and decodes it", async () => {
    const exit = await run(
      JSON.stringify({
        title: "Lemon Chicken",
        ingredients: ["chicken", "lemon"],
        prepMinutes: 10,
      }),
    )

    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value).toEqual({
        title: "Lemon Chicken",
        ingredients: ["chicken", "lemon"],
        prepMinutes: 10,
      })
    }
  })

  // The point of decoding locally: a server that enforced the schema can
  // still hand back something else, and that has to surface as a typed
  // failure rather than a wrongly-shaped object.
  it("fails typed when the answer does not match the schema", async () => {
    const exit = await run(JSON.stringify({ title: "X", ingredients: "wrong" }))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toMatch(/StructuredDecodeError/)
    }
  })
})
