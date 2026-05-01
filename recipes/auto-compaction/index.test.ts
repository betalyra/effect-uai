import { Effect, Stream, pipe } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, nextAfter, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"

describe("auto-compaction", () => {
  it("compacts every MAX_TURNS - 21 driven turns produces 4 compactions", async () => {
    const MAX_TURNS = 5
    const KEEP_RECENT_ITEMS = 2

    interface State {
      readonly history: ReadonlyArray<Items.Item>
      readonly turnIndex: number
      readonly cumulativeInputTokens: number
      readonly pendingPrompts: ReadonlyArray<string>
    }

    const advance = (state: State, turn: Turn.Turn): State => ({
      history: [...state.history, ...turn.items],
      turnIndex: state.turnIndex + 1,
      cumulativeInputTokens: state.cumulativeInputTokens + (turn.usage.input_tokens ?? 0),
      pendingPrompts: state.pendingPrompts,
    })

    const shouldCompact = (state: State): boolean => state.turnIndex >= MAX_TURNS

    const withSummary = (state: State, summary: string): State => ({
      history: [
        Items.userText(`[Summary]: ${summary}`),
        ...state.history.slice(-KEEP_RECENT_ITEMS),
      ],
      turnIndex: 0,
      cumulativeInputTokens: 0,
      pendingPrompts: state.pendingPrompts,
    })

    const PROMPTS = Array.from({ length: 21 }, (_, i) => `prompt ${i + 1}`)

    const initial: State = {
      history: [Items.userText(PROMPTS[0]!)],
      turnIndex: 0,
      cumulativeInputTokens: 0,
      pendingPrompts: PROMPTS.slice(1),
    }

    // Script the model: 21 normal turns interleaved with 4 compaction turns,
    // matching the loop's expected call sequence
    // (5 normal -> compaction -> 5 normal -> compaction -> ... -> 1 final normal).
    const normalTurn = (label: string): Turn.Turn => ({
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
    const compactionTurn = (label: string): Turn.Turn => ({
      stop_reason: "stop",
      usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: label }],
        },
      ],
    })

    const COMPACTION_INDICES = new Set([5, 11, 17, 23])
    const scriptedTurns: Turn.Turn[] = []
    let normalCount = 0
    let compactionCount = 0
    for (let i = 0; i < 25; i++) {
      if (COMPACTION_INDICES.has(i)) {
        compactionCount++
        scriptedTurns.push(compactionTurn(`summary-${compactionCount}`))
      } else {
        normalCount++
        scriptedTurns.push(normalTurn(`response-${normalCount}`))
      }
    }
    expect(scriptedTurns).toHaveLength(25)

    const { layer, recorder } = MockProvider.layerWithRecorder(scriptedTurns)

    // Same shape as the recipe, against `LanguageModel` for testability.
    const conversation = pipe(
      initial,
      loop((state) =>
        Effect.gen(function* () {
          const lm = yield* LanguageModel

          if (shouldCompact(state)) {
            const toCompact = state.history.slice(0, -KEEP_RECENT_ITEMS)
            return lm
              .streamTurn({
                history: [
                  ...toCompact,
                  Items.userText(
                    "Summarize the conversation above in 2-3 sentences for use as context.",
                  ),
                ],
                model: "mock",
                tools: [],
              })
              .pipe(
                streamUntilComplete((turn) =>
                  Effect.sync(() => {
                    const summary = Turn.assistantMessages(turn)
                      .flatMap((m) => m.content)
                      .filter(Items.isOutputText)
                      .map((c) => c.text)
                      .join(" ")
                    return nextAfter(Stream.empty, withSummary(state, summary))
                  }),
                ),
              )
          }

          return lm.streamTurn({ history: state.history, model: "mock", tools: [] }).pipe(
            streamUntilComplete((turn) =>
              Effect.sync(() => {
                const next = advance(state, turn)
                if (state.pendingPrompts.length === 0) return stop
                const [nextPrompt, ...rest] = state.pendingPrompts
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

    const program = Effect.gen(function* () {
      yield* Stream.runDrain(conversation)
      return yield* recorder
    })

    const { calls } = await Effect.runPromise(program.pipe(Effect.provide(layer)))

    // Total model calls: 21 normal + 4 compaction = 25.
    expect(calls).toHaveLength(25)

    // Compaction calls are the ones whose final history message is the
    // summarization prompt.
    const isCompactionCall = (history: ReadonlyArray<Items.Item>): boolean => {
      const last = history[history.length - 1]
      return (
        last !== undefined &&
        last.type === "message" &&
        last.role === "user" &&
        last.content.some(
          (block) =>
            block.type === "input_text" &&
            block.text.startsWith("Summarize the conversation above"),
        )
      )
    }

    const compactionCalls = calls.filter((c) => isCompactionCall(c.history))
    expect(compactionCalls).toHaveLength(4)

    // Normal calls: 21 of them.
    const normalCalls = calls.filter((c) => !isCompactionCall(c.history))
    expect(normalCalls).toHaveLength(21)

    // After each compaction, the next normal call's history should start
    // with the summary message produced by the preceding compaction.
    const compactionPositions = calls
      .map((c, i) => (isCompactionCall(c.history) ? i : -1))
      .filter((i) => i !== -1)
    for (const pos of compactionPositions) {
      const nextCall = calls[pos + 1]
      if (nextCall === undefined) continue
      const first = nextCall.history[0]
      expect(first?.type).toBe("message")
      if (first?.type !== "message") continue
      expect(first.role).toBe("user")
      const firstText = first.content.find(Items.isInputText)
      expect(firstText?.text.startsWith("[Summary]:")).toBe(true)
    }
  })
})
