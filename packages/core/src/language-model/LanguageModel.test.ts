import { Cause, Effect, Exit, Layer, Option, Ref, Schedule, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AiError from "../domain/AiError.js"
import * as Items from "../domain/Items.js"
import { type Turn, TurnEvent } from "../domain/Turn.js"
import { LanguageModel, retry, turn } from "./LanguageModel.js"
import * as MockProvider from "../testing/MockProvider.js"

const oneTextTurn = (text: string): Turn => ({
  items: [Items.assistantText(text)],
  usage: { input_tokens: 1, output_tokens: 1 },
  stop_reason: "stop",
})

describe("LanguageModel.turn", () => {
  it("returns the assembled Turn from the terminal TurnComplete event", async () => {
    const expected = oneTextTurn("hello world")
    const program = turn({ history: [Items.userText("hi")], model: "mock" })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(MockProvider.layer([expected]))),
    )

    expect(result).toEqual(expected)
  })

  it("fails with IncompleteTurn when the stream ends without TurnComplete", async () => {
    // Custom service whose stream emits a single TextDelta and then ends.
    const broken = Layer.succeed(LanguageModel, {
      streamTurn: () => Stream.fromIterable<TurnEvent>([TurnEvent.TextDelta({ text: "partial" })]),
    })

    const program = turn({ history: [Items.userText("hi")], model: "mock" })
    const exit = await Effect.runPromise(Effect.exit(program.pipe(Effect.provide(broken))))

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

  it("returns the LAST TurnComplete when the stream contains multiple (defensive)", async () => {
    // A misbehaving provider might emit two TurnComplete events; turn
    // should pick the last one (the most recent assembled Turn).
    const first = oneTextTurn("first")
    const second = oneTextTurn("second")
    const weird = Layer.succeed(LanguageModel, {
      streamTurn: () =>
        Stream.fromIterable<TurnEvent>([
          TurnEvent.TurnComplete({ turn: first }),
          TurnEvent.TurnComplete({ turn: second }),
        ]),
    })

    const program = turn({ history: [], model: "mock" })
    const result = await Effect.runPromise(program.pipe(Effect.provide(weird)))

    expect(result).toEqual(second)
  })
})

describe("LanguageModel.retry", () => {
  const textDelta = (text: string): TurnEvent => TurnEvent.TextDelta({ text })
  const textTurn = (text: string): Turn => ({
    items: [Items.assistantText(text)],
    usage: { input_tokens: 0, output_tokens: 0 },
    stop_reason: "stop",
  })
  const completeEvent = (text: string): TurnEvent =>
    TurnEvent.TurnComplete({ turn: textTurn(text) })

  // Builds a stream that emits a failure or success based on attempt counter.
  // Each call to the returned Effect produces a fresh attempt stream.
  const attemptStream = (
    attempts: Ref.Ref<number>,
    plan: ReadonlyArray<Stream.Stream<TurnEvent, AiError.AiError>>,
  ): Stream.Stream<TurnEvent, AiError.AiError> =>
    Stream.unwrap(
      Ref.getAndUpdate(attempts, (n) => n + 1).pipe(
        Effect.map((n) => plan[Math.min(n, plan.length - 1)]!),
      ),
    )

  it("retries on RateLimited and yields the success on the next attempt", async () => {
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const stream = attemptStream(attempts, [
        Stream.fail(new AiError.RateLimited({ provider: "mock", raw: null })),
        Stream.fromIterable([textDelta("ok"), completeEvent("ok")]),
      ]).pipe(retry(Schedule.recurs(3)))
      const events = yield* Stream.runCollect(stream)
      const count = yield* Ref.get(attempts)
      return { events: Array.from(events), count }
    })

    const { events, count } = await Effect.runPromise(program)
    expect(count).toBe(2)
    expect(events.map((e) => e._tag)).toEqual(["TextDelta", "TurnComplete"])
  })

  it("surfaces the underlying retryable failure when retries are exhausted", async () => {
    const cause = new AiError.Unavailable({ provider: "mock", raw: null })
    const stream = Stream.fail<AiError.AiError>(cause).pipe(retry(Schedule.recurs(2)))

    const exit = await Effect.runPromise(Effect.exit(Stream.runCollect(stream)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(cause))
    }
  })

  it("bypasses retry for non-retryable AiError (ContentFiltered)", async () => {
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const cause = new AiError.ContentFiltered({ provider: "mock", raw: null })
      const stream = attemptStream(attempts, [Stream.fail(cause)]).pipe(retry(Schedule.recurs(5)))
      const exit = yield* Effect.exit(Stream.runCollect(stream))
      const count = yield* Ref.get(attempts)
      return { exit, count, cause }
    })

    const { exit, count, cause } = await Effect.runPromise(program)
    expect(count).toBe(1) // no retry happened
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(cause))
    }
  })

  it("preserves deltas emitted before a retryable failure (and replays on retry)", async () => {
    // Documents the 'replays on retry' caveat in the JSDoc — first attempt
    // emits a delta then fails; second attempt is a clean success. Consumer
    // sees the first delta twice (once from the failed attempt, once from
    // the replay).
    const program = Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const stream = attemptStream(attempts, [
        Stream.concat(
          Stream.succeed<TurnEvent>(textDelta("partial")),
          Stream.fail(new AiError.Timeout({ provider: "mock", raw: null })),
        ),
        Stream.fromIterable([textDelta("partial"), completeEvent("done")]),
      ]).pipe(retry(Schedule.recurs(1)))
      const events = yield* Stream.runCollect(stream)
      return Array.from(events)
    })

    const events = await Effect.runPromise(program)
    expect(events.map((e) => e._tag)).toEqual(["TextDelta", "TextDelta", "TurnComplete"])
  })
})
