import { Cause, Effect, Exit, Layer, Option, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AiError from "../domain/AiError.js"
import * as Items from "../domain/Items.js"
import type { Turn, TurnEvent } from "../domain/Turn.js"
import { LanguageModel, turn } from "./LanguageModel.js"
import * as MockProvider from "../testing/MockProvider.js"

const oneTextTurn = (text: string): Turn => ({
  items: [Items.assistantText(text)],
  usage: { input_tokens: 1, output_tokens: 1 },
  stop_reason: "stop",
})

describe("LanguageModel.turn", () => {
  it("returns the assembled Turn from the terminal turn_complete event", async () => {
    const expected = oneTextTurn("hello world")
    const program = turn({ history: [Items.userText("hi")], model: "mock" })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockProvider.layer([expected]))),
    )

    expect(result).toEqual(expected)
  })

  it("fails with IncompleteTurn when the stream ends without turn_complete", async () => {
    // Custom service whose stream emits a single text_delta and then ends.
    const broken = Layer.succeed(LanguageModel, {
      streamTurn: () =>
        Stream.fromIterable<TurnEvent>([{ type: "text_delta", text: "partial" }]),
    })

    const program = turn({ history: [Items.userText("hi")], model: "mock" })
    const exit = await Effect.runPromise(
      Effect.exit(program.pipe(Effect.provide(broken))),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(AiError.IncompleteTurn)
      }
    }
  })

  it("propagates an AiError raised by streamTurn", async () => {
    const rateLimited = new AiError.RateLimited({ provider: "mock", raw: null })
    const failing = Layer.succeed(LanguageModel, {
      streamTurn: () => Stream.fail<AiError.AiError>(rateLimited),
    })

    const program = turn({ history: [], model: "mock" })
    const exit = await Effect.runPromise(Effect.exit(program.pipe(Effect.provide(failing))))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(rateLimited))
    }
  })

  it("returns the LAST turn_complete when the stream contains multiple (defensive)", async () => {
    // A misbehaving provider might emit two turn_complete events; turn
    // should pick the last one (the most recent assembled Turn).
    const first = oneTextTurn("first")
    const second = oneTextTurn("second")
    const weird = Layer.succeed(LanguageModel, {
      streamTurn: () =>
        Stream.fromIterable<TurnEvent>([
          { type: "turn_complete", turn: first },
          { type: "turn_complete", turn: second },
        ]),
    })

    const program = turn({ history: [], model: "mock" })
    const result = await Effect.runPromise(program.pipe(Effect.provide(weird)))

    expect(result).toEqual(second)
  })
})
