/**
 * Drive the retry shape against a flaky in-memory model. The test
 * mirrors the recipe's pipeline but with a fast backoff so the
 * wallclock cost stays in milliseconds.
 */
import { Data, Effect, Ref, Schedule, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel, type LanguageModelService } from "@effect-uai/core/LanguageModel"
import * as Turn from "@effect-uai/core/Turn"

// Local copies of the recipe's internals so the test can build the same
// shape with a faster schedule.
type Item =
  | { readonly _tag: "Event"; readonly event: Turn.TurnEvent }
  | { readonly _tag: "Terminal"; readonly cause: AiError.AiError }

class Retryable extends Data.TaggedError("Retryable")<{
  readonly cause: AiError.AiError
}> {}

const isRetryable = (
  e: AiError.AiError,
): e is AiError.RateLimited | AiError.Unavailable | AiError.Timeout =>
  e._tag === "RateLimited" || e._tag === "Unavailable" || e._tag === "Timeout"

const fastBackoff = Schedule.exponential("1 millis", 2).pipe(Schedule.both(Schedule.recurs(3)))

const retried = Effect.gen(function* () {
  const lm = yield* LanguageModel
  return lm.streamTurn({ history: [Items.userText("hi")], model: "mock" }).pipe(
    Stream.map((event): Item => ({ _tag: "Event", event })),
    Stream.catchIf(
      isRetryable,
      (cause) => Stream.fail(new Retryable({ cause })),
      (cause) => Stream.succeed<Item>({ _tag: "Terminal", cause }),
    ),
    Stream.retry(fastBackoff),
    Stream.catchTag("Retryable", (e) => Stream.fail(e.cause)),
    Stream.flatMap((item) =>
      item._tag === "Event" ? Stream.succeed(item.event) : Stream.fail(item.cause),
    ),
  )
})

const finalTurn: Turn.Turn = {
  stop_reason: "stop",
  usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ok" }],
    },
  ],
}

/** A service that fails its first `failuresBefore` calls, then succeeds. */
const flakyService = (
  failuresBefore: number,
  failure: AiError.AiError,
  callsRef: Ref.Ref<number>,
): LanguageModelService => ({
  streamTurn: () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const n = yield* Ref.getAndUpdate(callsRef, (x) => x + 1)
        if (n < failuresBefore) return Stream.fail(failure)
        return Stream.fromIterable<Turn.TurnEvent>([
          Turn.TurnEvent.TextDelta({ text: "ok" }),
          Turn.TurnEvent.TurnComplete({ turn: finalTurn }),
        ])
      }),
    ),
})

const runWith = (service: LanguageModelService) =>
  Effect.runPromiseExit(
    Effect.flatMap(retried, Stream.runCollect).pipe(Effect.provideService(LanguageModel, service)),
  )

describe("model-retry", () => {
  it("retries on RateLimited and eventually succeeds", async () => {
    const callsRef = Ref.makeUnsafe(0)
    const service = flakyService(
      2,
      new AiError.RateLimited({ provider: "mock", raw: "limit" }),
      callsRef,
    )

    const exit = await runWith(service)

    expect(exit._tag).toBe("Success")
    expect(Ref.getUnsafe(callsRef)).toBe(3)
  })

  it("retries on Unavailable", async () => {
    const callsRef = Ref.makeUnsafe(0)
    const service = flakyService(
      1,
      new AiError.Unavailable({ provider: "mock", raw: "down" }),
      callsRef,
    )

    const exit = await runWith(service)

    expect(exit._tag).toBe("Success")
    expect(Ref.getUnsafe(callsRef)).toBe(2)
  })

  it("retries on Timeout", async () => {
    const callsRef = Ref.makeUnsafe(0)
    const service = flakyService(
      1,
      new AiError.Timeout({ provider: "mock", raw: "slow" }),
      callsRef,
    )

    const exit = await runWith(service)

    expect(exit._tag).toBe("Success")
    expect(Ref.getUnsafe(callsRef)).toBe(2)
  })

  it("propagates ContentFiltered without retrying", async () => {
    const callsRef = Ref.makeUnsafe(0)
    const service = flakyService(
      999,
      new AiError.ContentFiltered({ provider: "mock", raw: "blocked" }),
      callsRef,
    )

    const exit = await runWith(service)

    expect(exit._tag).toBe("Failure")
    expect(Ref.getUnsafe(callsRef)).toBe(1)
  })

  it("exhausts attempts and propagates the original AiError", async () => {
    const callsRef = Ref.makeUnsafe(0)
    const service = flakyService(
      999,
      new AiError.RateLimited({ provider: "mock", raw: "limit" }),
      callsRef,
    )

    const exit = await runWith(service)

    expect(exit._tag).toBe("Failure")
    // 1 initial + 3 retries = 4 calls.
    expect(Ref.getUnsafe(callsRef)).toBe(4)
  })
})
