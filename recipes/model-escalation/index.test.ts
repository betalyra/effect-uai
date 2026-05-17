import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import {
  type ConversationEvent,
  type Tier,
  conversation,
  initialState,
  lastAssistantText,
} from "./index.js"

describe("model-escalation", () => {
  const assistant = (text: string, stop_reason: Items.StopReason = "stop"): Turn.Turn => ({
    stop_reason,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    items: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  })

  const escalateCall = (args: { reason: string; question: string }): Turn.Turn => ({
    stop_reason: "tool_calls",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    items: [
      {
        type: "function_call",
        call_id: "c-esc",
        name: "escalate",
        arguments: JSON.stringify(args),
      },
    ],
  })

  const tierOf = (name: string, model: string, turn: Turn.Turn) => {
    const { service, recorder } = MockProvider.make([turn])
    return { tier: { name, model, service } satisfies Tier, recorder }
  }

  it("cheap tier answers directly when no escalate call is made", async () => {
    const { tier: cheap, recorder: cheapCalls } = tierOf(
      "cheap",
      "mock-cheap",
      assistant("Lisbon."),
    )
    const { tier: strong, recorder: strongCalls } = tierOf(
      "strong",
      "mock-strong",
      assistant("(should not run)"),
    )

    const events = (await Effect.runPromise(
      Stream.runCollect(conversation(cheap, strong)(initialState("Capital of Portugal?"))),
    )) as ReadonlyArray<ConversationEvent>

    expect(lastAssistantText(events)).toBe("Lisbon.")
    expect((await Effect.runPromise(cheapCalls)).calls).toHaveLength(1)
    expect((await Effect.runPromise(strongCalls)).calls).toHaveLength(0)

    const announcements = events.filter(
      (e): e is Extract<ConversationEvent, { _tag: "tier_active" }> =>
        "_tag" in e && e._tag === "tier_active",
    )
    expect(announcements).toHaveLength(1)
    expect(announcements[0]?.tier).toBe("cheap")
  })

  it("escalates to the strong tier when cheap calls the escalate tool", async () => {
    const escalation = {
      reason: "quantum mechanics requires deep expertise",
      question: "Why does a quantum harmonic oscillator have non-zero ground-state energy?",
    }
    const { tier: cheap, recorder: cheapCalls } = tierOf(
      "cheap",
      "mock-cheap",
      escalateCall(escalation),
    )
    const { tier: strong, recorder: strongCalls } = tierOf(
      "strong",
      "mock-strong",
      assistant("Zero-point energy from the Heisenberg uncertainty principle."),
    )

    const events = (await Effect.runPromise(
      Stream.runCollect(
        conversation(cheap, strong)(initialState("Explain quantum harmonic oscillator")),
      ),
    )) as ReadonlyArray<ConversationEvent>

    // Cheap tier ran once, strong tier ran once.
    expect((await Effect.runPromise(cheapCalls)).calls).toHaveLength(1)
    const strongRecorded = (await Effect.runPromise(strongCalls)).calls
    expect(strongRecorded).toHaveLength(1)

    // Strong tier saw the same accumulated history the cheap tier saw -
    // no system prompt, no cheap-tier turn, no escalate function call.
    expect(strongRecorded[0]?.history).toEqual([
      Items.userText("Explain quantum harmonic oscillator"),
    ])

    // The escalated event was emitted with the cheap tier's reason + question.
    const escalated = events.find(
      (e): e is Extract<ConversationEvent, { _tag: "escalated" }> =>
        "_tag" in e && e._tag === "escalated",
    )
    expect(escalated).toEqual({
      _tag: "escalated",
      reason: escalation.reason,
      question: escalation.question,
    })

    // Two tier_active announcements: cheap then strong, in order.
    const announcements = events.filter(
      (e): e is Extract<ConversationEvent, { _tag: "tier_active" }> =>
        "_tag" in e && e._tag === "tier_active",
    )
    expect(announcements.map((a) => a.tier)).toEqual(["cheap", "strong"])

    // Final assistant text comes from the strong tier.
    expect(lastAssistantText(events)).toBe(
      "Zero-point energy from the Heisenberg uncertainty principle.",
    )
  })

  it("stops without escalating when escalate call has malformed arguments", async () => {
    const { tier: cheap } = tierOf("cheap", "mock-cheap", {
      stop_reason: "tool_calls",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      items: [
        {
          type: "function_call",
          call_id: "c-bad",
          name: "escalate",
          arguments: "not valid json",
        },
      ],
    })
    const { tier: strong, recorder: strongCalls } = tierOf(
      "strong",
      "mock-strong",
      assistant("(should not run)"),
    )

    await Effect.runPromise(
      Stream.runCollect(conversation(cheap, strong)(initialState("anything"))),
    )

    expect((await Effect.runPromise(strongCalls)).calls).toHaveLength(0)
  })
})
