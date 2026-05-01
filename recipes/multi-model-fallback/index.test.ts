import { Effect, Stream, pipe } from "effect"
import { describe, expect, it } from "vitest"
import * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import { loop, nextAfter, stop, streamUntilComplete } from "@effect-uai/core/Loop"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"

describe("multi-model-fallback", () => {
  interface Tier {
    readonly name: string
    readonly service: LanguageModelService
  }

  interface State {
    readonly history: ReadonlyArray<Items.Item>
    readonly tier: number
  }

  const initial: State = {
    history: [Items.userText("ping")],
    tier: 0,
  }

  const finalTurn = (label: string): Turn.Turn => ({
    stop_reason: "stop",
    usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
    items: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: label }],
      },
    ],
  })

  const failingService = (error: AiError.AiError, onCall: () => void): LanguageModelService => ({
    streamTurn: () =>
      Stream.unwrap(
        Effect.sync(() => {
          onCall()
          return Stream.fail(error)
        }),
      ),
  })

  const buildConversation = (tiers: ReadonlyArray<Tier>) =>
    pipe(
      initial,
      loop((state) =>
        Effect.gen(function* () {
          const tier = tiers[state.tier]
          if (tier === undefined) return stop

          const advance = nextAfter(Stream.empty, { ...state, tier: state.tier + 1 })

          return tier.service.streamTurn(state.history, {}).pipe(
            streamUntilComplete(() => Effect.sync(() => stop)),
            Stream.catchTag("RateLimited", () => advance),
            Stream.catchTag("Unavailable", () => advance),
          )
        }),
      ),
    )

  it("falls back to the next tier on RateLimited", async () => {
    let primaryCalls = 0
    const primary = failingService(
      new AiError.RateLimited({ provider: "primary", raw: "limit" }),
      () => {
        primaryCalls++
      },
    )
    const { service: secondary, recorder } = MockProvider.make([finalTurn("from-secondary")])

    const conversation = buildConversation([
      { name: "primary", service: primary },
      { name: "secondary", service: secondary },
    ])

    const events = await Effect.runPromise(Stream.runCollect(conversation))

    expect(primaryCalls).toBe(1)
    const calls = (await Effect.runPromise(recorder)).calls
    expect(calls).toHaveLength(1)
    const completion = events.find((e) => e.type === "turn_complete")
    expect(completion).toBeDefined()
    if (completion?.type === "turn_complete") {
      const text = Turn.assistantMessages(completion.turn)
        .flatMap((m) => m.content)
        .filter(Items.isOutputText)
        .map((c) => c.text)
        .join("")
      expect(text).toBe("from-secondary")
    }
  })

  it("falls back on Unavailable", async () => {
    let primaryCalls = 0
    const primary = failingService(
      new AiError.Unavailable({ provider: "primary", raw: "down", status: 503 }),
      () => {
        primaryCalls++
      },
    )
    const { service: secondary } = MockProvider.make([finalTurn("ok")])

    const conversation = buildConversation([
      { name: "primary", service: primary },
      { name: "secondary", service: secondary },
    ])

    const events = await Effect.runPromise(Stream.runCollect(conversation))

    expect(primaryCalls).toBe(1)
    expect(events.some((e) => e.type === "turn_complete")).toBe(true)
  })

  it("propagates ContentFiltered without falling back", async () => {
    let primaryCalls = 0
    const primary = failingService(
      new AiError.ContentFiltered({ provider: "primary", raw: "blocked" }),
      () => {
        primaryCalls++
      },
    )
    let secondaryCalls = 0
    const secondary: LanguageModelService = {
      streamTurn: () =>
        Stream.unwrap(
          Effect.sync(() => {
            secondaryCalls++
            return Stream.fromIterable<Turn.TurnEvent>([
              { type: "turn_complete", turn: finalTurn("should-not-run") },
            ])
          }),
        ),
    }

    const conversation = buildConversation([
      { name: "primary", service: primary },
      { name: "secondary", service: secondary },
    ])

    const exit = await Effect.runPromiseExit(Stream.runCollect(conversation))

    expect(primaryCalls).toBe(1)
    expect(secondaryCalls).toBe(0)
    expect(exit._tag).toBe("Failure")
  })

  it("ends with a logged error when all tiers are exhausted", async () => {
    let primaryCalls = 0
    let secondaryCalls = 0
    const primary = failingService(
      new AiError.RateLimited({ provider: "primary", raw: "limit" }),
      () => {
        primaryCalls++
      },
    )
    const secondary = failingService(
      new AiError.Unavailable({ provider: "secondary", raw: "down" }),
      () => {
        secondaryCalls++
      },
    )

    const conversation = buildConversation([
      { name: "primary", service: primary },
      { name: "secondary", service: secondary },
    ])

    const events = await Effect.runPromise(Stream.runCollect(conversation))

    expect(primaryCalls).toBe(1)
    expect(secondaryCalls).toBe(1)
    expect(events.some((e) => e.type === "turn_complete")).toBe(false)
  })
})
