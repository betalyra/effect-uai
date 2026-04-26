import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Conversation from "../src/Conversation.js"
import * as Items from "../src/Items.js"
import { LanguageModel, streamTurn } from "../src/LanguageModel.js"
import * as MockProvider from "../src/providers/MockProvider.js"
import * as Tool from "../src/Tool.js"
import * as Toolkit from "../src/Toolkit.js"
import type { Turn, TurnDelta } from "../src/Turn.js"

// ---------------------------------------------------------------------------
// Tool — get_weather
// ---------------------------------------------------------------------------

const GetWeatherInput = Schema.Struct({ city: Schema.String })

const getWeather = Tool.make({
  name: "get_weather",
  description: "Look up the current temperature for a city.",
  inputSchema: GetWeatherInput,
  run: ({ city }) => Effect.succeed({ city, tempC: 18 })
})

const toolkit = Toolkit.make([getWeather])

// ---------------------------------------------------------------------------
// Scripted turns the mock provider will replay, in order.
// ---------------------------------------------------------------------------

const turn1: Turn = {
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Let me check the weather." }]
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: JSON.stringify({ city: "Lisbon" })
    }
  ],
  usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
  stop_reason: "tool_calls"
}

const turn2: Turn = {
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "It's 18°C in Lisbon." }]
    }
  ],
  usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
  stop_reason: "stop"
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation.unfold (PoC)", () => {
  it("runs a text → tool → text round-trip with the scripted mock", async () => {
    const { layer, recorder } = MockProvider.layerWithRecorder([turn1, turn2])

    const program = Effect.gen(function* () {
      const cursors = yield* Conversation.unfold(
        [Items.userText("What's the weather in Lisbon?")],
        Conversation.defaultStep(toolkit)
      ).pipe(Stream.runCollect)

      const calls = yield* recorder
      return { cursors, calls: calls.calls }
    })

    const { cursors, calls } = await Effect.runPromise(
      program.pipe(Effect.provide(layer))
    )

    // Provider was called exactly twice
    expect(calls).toHaveLength(2)

    // First call only saw the user message
    expect(calls[0]!.history).toEqual([
      Items.userText("What's the weather in Lisbon?")
    ])

    // Second call saw user msg + assistant turn-1 items + tool output
    const secondHistory = calls[1]!.history
    expect(secondHistory).toHaveLength(4) // user, asst-msg, fn-call, fn-output
    expect(secondHistory[0]).toMatchObject({ role: "user" })
    expect(secondHistory[1]).toMatchObject({
      type: "message",
      role: "assistant"
    })
    expect(secondHistory[2]).toMatchObject({
      type: "function_call",
      name: "get_weather"
    })
    expect(secondHistory[3]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1"
    })

    // The tool output round-trips as JSON
    const fnOutput = secondHistory[3] as Items.FunctionCallOutput
    expect(JSON.parse(fnOutput.output)).toEqual({ city: "Lisbon", tempC: 18 })

    // Two cursors emitted by the unfold (one per turn)
    expect(cursors).toHaveLength(2)
    expect(cursors[0]!.index).toBe(0)
    expect(cursors[0]!.turn.stop_reason).toBe("tool_calls")
    expect(cursors[1]!.index).toBe(1)
    expect(cursors[1]!.turn.stop_reason).toBe("stop")

    // Final cursor's history is the full conversation including the final
    // assistant message.
    const final = cursors[1]!.history
    expect(final).toHaveLength(5)
    const lastMsg = final[4] as Items.Message
    expect(lastMsg.type).toBe("message")
    expect(lastMsg.role).toBe("assistant")
    expect(lastMsg.content[0]).toEqual({
      type: "output_text",
      text: "It's 18°C in Lisbon."
    })
  })

  it("streamTurn yields delta-level events with turn_complete last", async () => {
    const program = Stream.runCollect(
      streamTurn([Items.userText("hi")])
    ).pipe(
      Effect.provide(MockProvider.layer([turn1]))
    )

    const deltas: ReadonlyArray<TurnDelta> = await Effect.runPromise(program)

    expect(deltas.map((d) => d.type)).toEqual([
      "text_delta",
      "tool_call_start",
      "tool_call_args_delta",
      "turn_complete"
    ])
    const last = deltas[deltas.length - 1]!
    expect(last.type).toBe("turn_complete")
    if (last.type === "turn_complete") {
      expect(last.turn.stop_reason).toBe("tool_calls")
    }
  })
})
