import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import { type LanguageModelService, turnFromStream } from "@effect-uai/core/LanguageModel"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import { type CouncilEvent, council } from "./council.js"

describe("multi-model-compare", () => {
  const finalTurn = (text: string): Turn.Turn => ({
    stop_reason: "stop",
    usage: { input_tokens: 4, output_tokens: 4, total_tokens: 8 },
    items: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  })

  const failingService = (error: AiError.AiError): LanguageModelService => {
    const streamTurn: LanguageModelService["streamTurn"] = () => Stream.fail(error)
    return { streamTurn, turn: turnFromStream(streamTurn) }
  }

  const history: ReadonlyArray<Items.HistoryItem> = [Items.userText("ping")]

  it("tags each member's deltas and surfaces all three TurnCompletes", async () => {
    const { service: openai } = MockProvider.make([finalTurn("from-openai")])
    const { service: google } = MockProvider.make([finalTurn("from-google")])
    const { service: anthropic } = MockProvider.make([finalTurn("from-anthropic")])

    const events = await Effect.runPromise(
      Stream.runCollect(
        council(
          [
            { name: "openai", model: "mock-openai", service: openai },
            { name: "google", model: "mock-google", service: google },
            { name: "anthropic", model: "mock-anthropic", service: anthropic },
          ],
          history,
        ),
      ),
    )

    const completions = events.filter(
      (e): e is Extract<CouncilEvent, { type: "delta" }> =>
        e.type === "delta" && e.delta._tag === "TurnComplete",
    )
    expect(completions).toHaveLength(3)

    const members = new Set(completions.map((c) => c.member))
    expect(members).toEqual(new Set(["openai", "google", "anthropic"]))

    // Each member's text deltas exist and carry their tag.
    const textDeltasByMember = new Map<string, string>()
    for (const e of events) {
      if (e.type === "delta" && e.delta._tag === "TextDelta") {
        textDeltasByMember.set(e.member, (textDeltasByMember.get(e.member) ?? "") + e.delta.text)
      }
    }
    expect(textDeltasByMember.get("openai")).toBe("from-openai")
    expect(textDeltasByMember.get("google")).toBe("from-google")
    expect(textDeltasByMember.get("anthropic")).toBe("from-anthropic")
  })

  it("isolates a failing member without killing the council", async () => {
    const { service: openai } = MockProvider.make([finalTurn("ok-openai")])
    const google = failingService(new AiError.RateLimited({ provider: "google", raw: "limit" }))
    const { service: anthropic } = MockProvider.make([finalTurn("ok-anthropic")])

    const events = await Effect.runPromise(
      Stream.runCollect(
        council(
          [
            { name: "openai", model: "mock-openai", service: openai },
            { name: "google", model: "mock-google", service: google },
            { name: "anthropic", model: "mock-anthropic", service: anthropic },
          ],
          history,
        ),
      ),
    )

    const errors = events.filter((e) => e.type === "error")
    expect(errors).toHaveLength(1)
    expect(errors[0]!.type === "error" && errors[0]!.member).toBe("google")

    const completions = events.filter((e) => e.type === "delta" && e.delta._tag === "TurnComplete")
    expect(completions).toHaveLength(2)
    const completedMembers = new Set(completions.map((e) => (e.type === "delta" ? e.member : "")))
    expect(completedMembers).toEqual(new Set(["openai", "anthropic"]))
  })

  it("uses the same history for every member", async () => {
    const { service: openai, recorder: openaiRec } = MockProvider.make([finalTurn("a")])
    const { service: google, recorder: googleRec } = MockProvider.make([finalTurn("b")])
    const { service: anthropic, recorder: anthropicRec } = MockProvider.make([finalTurn("c")])

    await Effect.runPromise(
      Stream.runCollect(
        council(
          [
            { name: "openai", model: "mock-openai", service: openai },
            { name: "google", model: "mock-google", service: google },
            { name: "anthropic", model: "mock-anthropic", service: anthropic },
          ],
          history,
        ),
      ),
    )

    const oa = await Effect.runPromise(openaiRec)
    const go = await Effect.runPromise(googleRec)
    const an = await Effect.runPromise(anthropicRec)

    for (const rec of [oa, go, an]) {
      expect(rec.calls).toHaveLength(1)
      expect(rec.calls[0]!.history).toEqual(history)
    }
  })
})
