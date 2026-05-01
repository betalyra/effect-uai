import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import * as Lines from "@effect-uai/core/Lines"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"
import * as Items from "@effect-uai/core/Items"

const Recipe = Schema.Struct({
  title: Schema.String,
  ingredients: Schema.Array(Schema.String),
  prepMinutes: Schema.Number,
})

const recipeFormat = StructuredFormat.fromEffectSchema(Recipe)

const jsonl = (recipes: ReadonlyArray<typeof Recipe.Type>) =>
  recipes.map((r) => JSON.stringify(r)).join("\n")

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

describe("structured-output: streaming JSONL", () => {
  it("decodes each line into a Recipe", async () => {
    const recipes = [
      { title: "A", ingredients: ["x"], prepMinutes: 1 },
      { title: "B", ingredients: ["y", "z"], prepMinutes: 2 },
      { title: "C", ingredients: ["q"], prepMinutes: 3 },
    ]
    const { layer } = MockProvider.layerWithRecorder([turnWithText(jsonl(recipes))])

    const program = streamTurn({ history: [Items.userText("ignored")], model: "mock" }).pipe(
      Turn.textDeltas,
      Lines.lines,
      StructuredFormat.decodeJsonLines(recipeFormat),
      Stream.runCollect,
    )

    const decoded = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    expect(decoded).toEqual(recipes)
  })

  it("flushes the trailing object with lines", async () => {
    const recipes = [{ title: "Solo", ingredients: ["x"], prepMinutes: 5 }]
    const { layer } = MockProvider.layerWithRecorder([turnWithText(jsonl(recipes))])

    const program = streamTurn({ history: [Items.userText("ignored")], model: "mock" }).pipe(
      Turn.textDeltas,
      Lines.lines,
      StructuredFormat.decodeJsonLines(recipeFormat),
      Stream.runCollect,
    )

    const decoded = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    expect(decoded).toEqual(recipes)
  })

  it("surfaces JsonParseError on a malformed line", async () => {
    const text = [
      JSON.stringify({ title: "A", ingredients: ["x"], prepMinutes: 1 }),
      "not json",
    ].join("\n")
    const { layer } = MockProvider.layerWithRecorder([turnWithText(text)])

    const program = streamTurn({ history: [Items.userText("ignored")], model: "mock" }).pipe(
      Turn.textDeltas,
      Lines.lines,
      StructuredFormat.decodeJsonLines(recipeFormat),
      Stream.runCollect,
    )

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const tag = JSON.stringify(exit.cause).match(/StructuredJsonParseError/)
      expect(tag).not.toBeNull()
    }
  })

  it("surfaces StructuredDecodeError on shape mismatch", async () => {
    const text = [
      JSON.stringify({ title: "A", ingredients: ["x"], prepMinutes: 1 }),
      JSON.stringify({ title: "B", ingredients: "wrong", prepMinutes: 2 }),
    ].join("\n")
    const { layer } = MockProvider.layerWithRecorder([turnWithText(text)])

    const program = streamTurn({ history: [Items.userText("ignored")], model: "mock" }).pipe(
      Turn.textDeltas,
      Lines.lines,
      StructuredFormat.decodeJsonLines(recipeFormat),
      Stream.runCollect,
    )

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const tag = JSON.stringify(exit.cause).match(/StructuredDecodeError/)
      expect(tag).not.toBeNull()
    }
  })
})
