import type { HistoryItem } from "@effect-uai/core/Items"
import { describe, expect, it } from "vitest"
import {
  type Accumulator,
  accumulatorToTurn,
  applyChunk,
  emptyAccumulator,
  itemsToMessages,
  toolChoiceWire,
  type WireChunk,
} from "./codec.js"

describe("itemsToMessages", () => {
  // The interesting case: our flat history (assistant message, then separate
  // function_call items) must fold into the OpenAI/Mistral shape where the
  // tool calls ride the assistant message and each result is a `tool` message.
  it("folds tool calls onto the assistant message and emits tool results", () => {
    const history: ReadonlyArray<HistoryItem> = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      { type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "b", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ra" },
    ]
    expect(itemsToMessages(history)).toEqual([
      {
        role: "assistant",
        content: "checking",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "ra" },
    ])
  })

  it("encodes a message with an image as multimodal parts", () => {
    const history: ReadonlyArray<HistoryItem> = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is this" },
          { type: "input_image", source: { _tag: "url", url: "https://x/y.png" } },
        ],
      },
    ]
    expect(itemsToMessages(history)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: "https://x/y.png" },
        ],
      },
    ])
  })
})

it("toolChoiceWire maps 'required' to Mistral's 'any'", () => {
  // Mistral diverges from OpenAI here; the rest pass through unchanged.
  expect(toolChoiceWire("required")).toBe("any")
})

// Run a sequence of chunks through the accumulator, collecting event tags.
const runChunks = (
  chunks: ReadonlyArray<WireChunk>,
): { acc: Accumulator; tags: ReadonlyArray<string> } => {
  let acc = emptyAccumulator
  const tags: Array<string> = []
  for (const chunk of chunks) {
    const [next, events] = applyChunk(acc, chunk)
    acc = next
    for (const e of events) tags.push(e._tag)
  }
  return { acc, tags }
}

describe("streaming accumulation", () => {
  it("accumulates text deltas + usage into an assistant turn", () => {
    const { acc, tags } = runChunks([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ])
    expect(tags).toEqual(["TextDelta", "TextDelta", "UsageUpdate"])
    const turn = accumulatorToTurn(acc)
    expect(turn.items).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
    ])
    expect(turn.usage).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5 })
    expect(turn.stop_reason).toBe("stop")
  })

  it("stitches a tool call split across chunks", () => {
    const { acc, tags } = runChunks([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "get_weather", arguments: '{"ci' } },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"NYC"}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ])
    expect(tags).toEqual(["ToolCallStart", "ToolCallArgsDelta", "ToolCallArgsDelta"])
    const turn = accumulatorToTurn(acc)
    expect(turn.items).toEqual([
      { type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"NYC"}' },
    ])
    expect(turn.stop_reason).toBe("tool_calls")
  })
})
