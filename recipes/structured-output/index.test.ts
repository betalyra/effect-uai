import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"

const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe, {
  name: "Recipe",
  description: "A short cooking recipe.",
  strict: true,
})

const turnWithText = (text: string): Turn.Turn => ({
  stop_reason: "stop",
  usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  ],
})

describe("structured-output: single object", () => {
  it("decodes valid JSON into a Recipe", async () => {
    const turn = turnWithText(
      JSON.stringify({
        title: "Lemon Chicken",
        ingredients: ["chicken", "lemon"],
        prepMinutes: 10,
      }),
    )

    const recipe = await Effect.runPromise(Turn.toStructured(turn, recipeFormat))

    expect(recipe).toEqual({
      title: "Lemon Chicken",
      ingredients: ["chicken", "lemon"],
      prepMinutes: 10,
    })
  })

  it("fails with JsonParseError on invalid JSON", async () => {
    const turn = turnWithText("not json")

    const exit = await Effect.runPromiseExit(Turn.toStructured(turn, recipeFormat))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = exit.cause
      const tag = JSON.stringify(failure).match(/StructuredJsonParseError/)
      expect(tag).not.toBeNull()
    }
  })

  it("fails with StructuredDecodeError on shape mismatch", async () => {
    const turn = turnWithText(JSON.stringify({ title: "X", ingredients: "wrong" }))

    const exit = await Effect.runPromiseExit(Turn.toStructured(turn, recipeFormat))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const tag = JSON.stringify(exit.cause).match(/StructuredDecodeError/)
      expect(tag).not.toBeNull()
    }
  })

  it("rejects refusal-only turns with RefusalRejected", async () => {
    const turn: Turn.Turn = {
      stop_reason: "stop",
      usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", text: "I can't help with that." }],
        },
      ],
    }

    const exit = await Effect.runPromiseExit(Turn.toStructured(turn, recipeFormat))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const tag = JSON.stringify(exit.cause).match(/RefusalRejected/)
      expect(tag).not.toBeNull()
    }
  })
})
