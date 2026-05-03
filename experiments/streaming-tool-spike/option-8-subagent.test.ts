/**
 * End-to-end test of the sub-agent spike.
 *
 * Verifies:
 *   - The sub-agent tool's inner Stream<TurnEvent> flows through to the
 *     consumer as `ToolEvent.Intermediate` events.
 *   - The reducer accumulates text_delta payloads into the final answer.
 *   - The outer loop's `FunctionCallOutput` carries the structured
 *     `SubAgentOutput`, not the raw deltas.
 *   - The outer loop continues to a final answer after the sub-agent
 *     completes.
 */
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import type { ToolEvent } from "./option-8-always-stream.js"
import { type SubAgentOutput, buildConversation } from "./option-8-subagent.js"

// ---------------------------------------------------------------------------
// Mocked inner agent: a hand-crafted Stream<TurnEvent> simulating a
// streaming sub-loop. Real recipes would pass a function that runs an
// inner `loop` against a sub-LanguageModel layer; the spike's
// signature is the same either way.
// ---------------------------------------------------------------------------

const mockedInnerAgent = (question: string): Stream.Stream<Turn.TurnEvent> =>
  Stream.fromIterable<Turn.TurnEvent>([
    { type: "text_delta", text: `Hmm, "${question}"... ` },
    { type: "text_delta", text: "let me reason... " },
    { type: "text_delta", text: "the answer is 42." },
    {
      type: "turn_complete",
      turn: {
        stop_reason: "stop",
        usage: { input_tokens: 5, output_tokens: 8, total_tokens: 13 },
        items: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: `Hmm, "${question}"... let me reason... the answer is 42.`,
              },
            ],
          },
        ],
      },
    },
  ])

// ---------------------------------------------------------------------------
// Outer loop's MockProvider script.
// ---------------------------------------------------------------------------

const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

const outerScript: ReadonlyArray<Turn.Turn> = [
  {
    stop_reason: "tool_calls",
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
    items: [fc("c1", "ask_subagent", { question: "What is the meaning of life?" })],
  },
  {
    stop_reason: "stop",
    usage: { input_tokens: 25, output_tokens: 15, total_tokens: 40 },
    items: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "The sub-agent reasoned through it and concluded: 42.",
          },
        ],
      },
    ],
  },
]

describe("sub-agent recipe (option 8)", () => {
  it("runs the outer loop, calls sub-agent, threads inner deltas through, completes", async () => {
    const initial = {
      history: [
        Items.userText("Find out the meaning of life by asking a sub-agent."),
      ] as ReadonlyArray<Items.Item>,
    }

    const conversation = buildConversation(initial, mockedInnerAgent)

    const collected = await Effect.runPromise(
      Stream.runCollect(conversation).pipe(Effect.provide(MockProvider.layer(outerScript))),
    )

    // The outer loop yields: turn_complete (turn 1), 3 sub-agent intermediates
    // + 1 sub-agent Output, turn_complete (turn 2). The exact ordering of
    // intermediates relative to outer events depends on streamUntilComplete.
    // What we care about: every expected event appears.

    // 1. Two turn_complete events (turn 1 with tool call, turn 2 final).
    const turnCompletes = collected.filter(
      (e): e is Extract<Turn.TurnEvent, { type: "turn_complete" }> =>
        "type" in e && e.type === "turn_complete",
    )
    expect(turnCompletes).toHaveLength(2)
    expect(turnCompletes[0]!.turn.stop_reason).toBe("tool_calls")
    expect(turnCompletes[1]!.turn.stop_reason).toBe("stop")

    // 2. Sub-agent Intermediate ToolEvents - one per inner-stream element.
    // The mocked inner stream emits 3 text_deltas + 1 turn_complete = 4
    // intermediates. All are tagged with the call_id + tool name.
    const intermediates = collected.filter(
      (e): e is Extract<ToolEvent, { _tag: "Intermediate" }> =>
        "_tag" in e && (e as ToolEvent)._tag === "Intermediate",
    )
    expect(intermediates).toHaveLength(4)
    intermediates.forEach((e) => {
      expect(e.call_id).toBe("c1")
      expect(e.tool).toBe("ask_subagent")
    })

    const textDeltas = intermediates.filter(
      (e) => (e.data as Turn.TurnEvent).type === "text_delta",
    )
    expect(textDeltas).toHaveLength(3)

    // 3. One Output ToolEvent. Its FunctionCallOutput's JSON is the
    // accumulated SubAgentOutput - the model sees a structured answer,
    // not the raw delta stream.
    const outputs = collected.filter(
      (e): e is Extract<ToolEvent, { _tag: "Output" }> =>
        "_tag" in e && (e as ToolEvent)._tag === "Output",
    )
    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.output.call_id).toBe("c1")
    const parsed = JSON.parse(outputs[0]!.output.output) as SubAgentOutput
    expect(parsed.answer).toBe(
      'Hmm, "What is the meaning of life?"... let me reason... the answer is 42.',
    )
  })

  it("no tool calls in turn 1: the outer loop just stops, no sub-agent runs", async () => {
    // Variant: the outer model produces a final answer immediately.
    const directAnswerScript: ReadonlyArray<Turn.Turn> = [
      {
        stop_reason: "stop",
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        items: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I already know - 42." }],
          },
        ],
      },
    ]

    const initial = {
      history: [Items.userText("...")] as ReadonlyArray<Items.Item>,
    }

    const conversation = buildConversation(initial, mockedInnerAgent)

    const collected = await Effect.runPromise(
      Stream.runCollect(conversation).pipe(
        Effect.provide(MockProvider.layer(directAnswerScript)),
      ),
    )

    // No intermediates, no sub-agent outputs.
    const intermediates = collected.filter(
      (e): e is Extract<ToolEvent, { _tag: "Intermediate" }> =>
        "_tag" in e && (e as ToolEvent)._tag === "Intermediate",
    )
    expect(intermediates).toHaveLength(0)

    const outputs = collected.filter(
      (e): e is Extract<ToolEvent, { _tag: "Output" }> =>
        "_tag" in e && (e as ToolEvent)._tag === "Output",
    )
    expect(outputs).toHaveLength(0)

    // Just one turn_complete with stop_reason="stop".
    const turnCompletes = collected.filter(
      (e): e is Extract<Turn.TurnEvent, { type: "turn_complete" }> =>
        "type" in e && e.type === "turn_complete",
    )
    expect(turnCompletes).toHaveLength(1)
    expect(turnCompletes[0]!.turn.stop_reason).toBe("stop")
  })
})
