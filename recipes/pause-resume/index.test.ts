import { Effect, Fiber, Latch, Ref, Stream, pipe } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@betalyra/effect-uai-core/Items"
import { LanguageModel } from "@betalyra/effect-uai-core/LanguageModel"
import { loop, nextAfter, stop, streamUntilComplete } from "@betalyra/effect-uai-core/Loop"
import * as MockProvider from "@betalyra/effect-uai-core/testing/MockProvider"
import * as Turn from "@betalyra/effect-uai-core/Turn"

describe("pause-resume", () => {
  const PROMPTS = ["prompt 1", "prompt 2", "prompt 3", "prompt 4", "prompt 5"]

  interface State {
    readonly history: ReadonlyArray<Items.Item>
    readonly pendingPrompts: ReadonlyArray<string>
  }

  const initial: State = {
    history: [Items.userText(PROMPTS[0]!)],
    pendingPrompts: PROMPTS.slice(1),
  }

  const advance = (state: State, turn: Turn.Turn): State => ({
    history: [...state.history, ...turn.items],
    pendingPrompts: state.pendingPrompts,
  })

  const turn = (label: string): Turn.Turn => ({
    stop_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    items: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: label }],
      },
    ],
  })

  const buildConversation = (pauseLatch: Latch.Latch, turnsCompleted: Ref.Ref<number>) =>
    pipe(
      initial,
      loop((state) =>
        Effect.gen(function* () {
          yield* Latch.await(pauseLatch)

          const lm = yield* LanguageModel
          return lm.streamTurn(state.history, { tools: [] }).pipe(
            streamUntilComplete((t) =>
              Effect.gen(function* () {
                yield* Ref.update(turnsCompleted, (n) => n + 1)
                const next = advance(state, t)
                if (next.pendingPrompts.length === 0) return stop
                const [nextPrompt, ...rest] = next.pendingPrompts
                return nextAfter(Stream.empty, {
                  ...next,
                  history: [...next.history, Items.userText(nextPrompt!)],
                  pendingPrompts: rest,
                })
              }),
            ),
          )
        }),
      ),
    )

  it("makes no provider calls while the latch is closed; resumes when opened", async () => {
    const scripted = PROMPTS.map((_, i) => turn(`response-${i + 1}`))
    const { layer, recorder } = MockProvider.layerWithRecorder(scripted)

    const program = Effect.gen(function* () {
      // Latch starts closed - the loop should suspend on the first iteration.
      const pauseLatch = yield* Latch.make(false)
      const turnsCompleted = yield* Ref.make(0)

      const fiber = yield* Effect.forkChild(
        Stream.runDrain(buildConversation(pauseLatch, turnsCompleted)),
      )

      // Give the fiber a chance to suspend on the latch.
      yield* Effect.sleep("20 millis")

      // Nothing should have happened yet.
      const before = yield* recorder
      expect(before.calls).toHaveLength(0)
      expect(yield* Ref.get(turnsCompleted)).toBe(0)

      // Resume.
      yield* Latch.open(pauseLatch)
      yield* Fiber.join(fiber)

      const after = yield* recorder
      expect(after.calls).toHaveLength(scripted.length)
      expect(yield* Ref.get(turnsCompleted)).toBe(scripted.length)
    })

    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })
})

// Note: a "close the latch partway through and watch the loop pause" test
// would race the synchronous MockProvider against the controller fiber.
// Making it deterministic needs coordinating primitives (Queue/Deferred) that
// don't belong in the recipe pattern. The mechanism (`Latch.await` gates the
// body) is already verified by the closed-then-open test above.
