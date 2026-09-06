import * as Items from "@effect-uai/core/Items"
import { type LanguageModelService, turnFromStream } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import { Deferred, Effect, Ref, Schedule, Stream, pipe } from "effect"
import { describe, expect, it } from "vitest"

describe("mid-stream-abort", () => {
  /**
   * A `LanguageModelService` whose stream emits five text deltas, each
   * spaced by 20ms, then a `TurnComplete`. The stream registers a
   * finalizer that flips `cleanedUp` so the test can verify the cleanup
   * chain ran when the consumer interrupted.
   */
  const slowService = (
    cleanedUp: Ref.Ref<boolean>,
    deltasEmitted: Ref.Ref<number>,
  ): LanguageModelService => {
    const streamTurn: LanguageModelService["streamTurn"] = () =>
      pipe(
        Stream.fromIterable<Turn.TurnEvent>([
          Turn.TurnEvent.TextDelta({ text: "one " }),
          Turn.TurnEvent.TextDelta({ text: "two " }),
          Turn.TurnEvent.TextDelta({ text: "three " }),
          Turn.TurnEvent.TextDelta({ text: "four " }),
          Turn.TurnEvent.TextDelta({ text: "five " }),
          Turn.TurnEvent.TurnComplete({
            turn: {
              stop_reason: "stop",
              usage: { input_tokens: 1, output_tokens: 5, total_tokens: 6 },
              items: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "one two three four five" }],
                },
              ],
            },
          }),
        ]),
        Stream.tap(() => Ref.update(deltasEmitted, (n) => n + 1)),
        Stream.schedule(Schedule.spaced("20 millis")),
        Stream.ensuring(Ref.set(cleanedUp, true)),
      )
    return { streamTurn, turn: turnFromStream(streamTurn) }
  }

  it("interrupts the stream and runs the upstream finalizer when abort fires", async () => {
    const program = Effect.gen(function* () {
      const cleanedUp = yield* Ref.make(false)
      const deltasEmitted = yield* Ref.make(0)
      const abort = yield* Deferred.make<void>()

      const service = slowService(cleanedUp, deltasEmitted)

      const conversation = pipe(
        { history: [Items.userText("go")] },
        loop((state) =>
          Effect.gen(function* () {
            return service
              .streamTurn({ history: state.history, model: "mock" })
              .pipe(onTurnComplete(() => Effect.sync(stop)))
          }),
        ),
        Stream.interruptWhen(Deferred.await(abort)),
      )

      // Fire abort after ~50ms so 1-2 deltas land first.
      yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Effect.sleep("50 millis")
          yield* Deferred.succeed(abort, undefined)
        }),
      )

      const collected = yield* Stream.runCollect(conversation)

      return {
        cleanedUp: yield* Ref.get(cleanedUp),
        deltasEmitted: yield* Ref.get(deltasEmitted),
        collectedCount: collected.length,
        sawTurnComplete: collected.some((e) => e._tag === "TurnComplete"),
      }
    })

    const result = await Effect.runPromise(program)

    expect(result.cleanedUp).toBe(true)
    // Should have collected fewer than the full 6 events (5 deltas + complete).
    expect(result.collectedCount).toBeLessThan(6)
    expect(result.sawTurnComplete).toBe(false)
  })

  it("runs to completion if abort never fires", async () => {
    const program = Effect.gen(function* () {
      const cleanedUp = yield* Ref.make(false)
      const deltasEmitted = yield* Ref.make(0)
      const abort = yield* Deferred.make<void>()

      const service = slowService(cleanedUp, deltasEmitted)

      const conversation = pipe(
        { history: [Items.userText("go")] },
        loop((state) =>
          Effect.gen(function* () {
            return service
              .streamTurn({ history: state.history, model: "mock" })
              .pipe(onTurnComplete(() => Effect.sync(stop)))
          }),
        ),
        Stream.interruptWhen(Deferred.await(abort)),
      )

      const collected = yield* Stream.runCollect(conversation)

      return {
        cleanedUp: yield* Ref.get(cleanedUp),
        sawTurnComplete: collected.some((e) => e._tag === "TurnComplete"),
      }
    })

    const result = await Effect.runPromise(program)

    expect(result.cleanedUp).toBe(true)
    expect(result.sawTurnComplete).toBe(true)
  })
})
