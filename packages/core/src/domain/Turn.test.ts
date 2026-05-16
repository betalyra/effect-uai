import { describe, expect, it } from "vitest"
import * as Items from "./Items.js"
import * as Turn from "./Turn.js"

const turnOf = (items: Turn.Turn["items"]): Turn.Turn => ({
  items,
  usage: { input_tokens: 0, output_tokens: 0 },
  stop_reason: "stop",
})

describe("Turn.assistantTexts", () => {
  it("returns each output_text block in order across a single assistant message", () => {
    const turn = turnOf([
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "first" },
          { type: "output_text", text: "second" },
        ],
      },
    ])

    expect(Turn.assistantTexts(turn)).toEqual(["first", "second"])
  })

  it("preserves order across multiple assistant messages", () => {
    const turn = turnOf([
      Items.assistantText("alpha"),
      Items.assistantText("beta"),
      Items.assistantText("gamma"),
    ])

    expect(Turn.assistantTexts(turn)).toEqual(["alpha", "beta", "gamma"])
  })

  it("drops refusal blocks and non-assistant messages", () => {
    const turn = turnOf([
      Items.userText("ignored"),
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "kept" },
          { type: "refusal", text: "I can't help with that." },
        ],
      },
    ])

    expect(Turn.assistantTexts(turn)).toEqual(["kept"])
  })

  it("returns an empty array when there's nothing to extract", () => {
    expect(Turn.assistantTexts(turnOf([]))).toEqual([])
    expect(Turn.assistantTexts(turnOf([Items.userText("only user")]))).toEqual([])
  })

  it("composes with caller-chosen separators", () => {
    const turn = turnOf([Items.assistantText("hello"), Items.assistantText("world")])

    expect(Turn.assistantTexts(turn).join("")).toBe("helloworld")
    expect(Turn.assistantTexts(turn).join(" ")).toBe("hello world")
    expect(Turn.assistantTexts(turn).join("\n")).toBe("hello\nworld")
  })
})

describe("Turn.assistantText", () => {
  it("concatenates output_text across a single assistant message's content blocks", () => {
    const turn = turnOf([
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "hello " },
          { type: "output_text", text: "world" },
        ],
      },
    ])

    expect(Turn.assistantText(turn)).toBe("hello world")
  })

  it("concatenates output_text across multiple assistant messages", () => {
    const turn = turnOf([Items.assistantText("first "), Items.assistantText("second")])

    expect(Turn.assistantText(turn)).toBe("first second")
  })

  it("ignores non-assistant messages", () => {
    const turn = turnOf([
      Items.userText("ignored"),
      Items.systemText("also ignored"),
      Items.assistantText("kept"),
    ])

    expect(Turn.assistantText(turn)).toBe("kept")
  })

  it("ignores non-output_text content blocks (refusals, etc.)", () => {
    const turn = turnOf([
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "before " },
          { type: "refusal", text: "I can't help with that." },
          { type: "output_text", text: "after" },
        ],
      },
    ])

    expect(Turn.assistantText(turn)).toBe("before after")
  })

  it("ignores function_call items even when interleaved with messages", () => {
    const turn = turnOf([
      Items.assistantText("text "),
      { type: "function_call", call_id: "c1", name: "search", arguments: "{}" },
      Items.assistantText("more text"),
    ])

    expect(Turn.assistantText(turn)).toBe("text more text")
  })

  it("returns the empty string when no assistant messages exist", () => {
    expect(Turn.assistantText(turnOf([]))).toBe("")
    expect(Turn.assistantText(turnOf([Items.userText("only user")]))).toBe("")
  })

  it("returns the empty string when the assistant message has no output_text blocks", () => {
    const turn = turnOf([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", text: "I can't help." }],
      },
    ])

    expect(Turn.assistantText(turn)).toBe("")
  })
})
