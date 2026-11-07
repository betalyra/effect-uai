import * as Image from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import * as Turn from "@effect-uai/core/Turn"
import { describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { expect } from "vitest"
import { decodeMessages } from "./Messages.js"
import { dataPart, type Emission, messageMetadata, toUIMessageStream } from "./UIMessageStream.js"

const turn = (items: ReadonlyArray<Items.HistoryItem>, stop: Items.StopReason): Turn.Turn => ({
  items,
  usage: {},
  stop_reason: stop,
})

// Run an InteractionEvent script through the encoder and return the decoded
// parts (the `data:` payload of each SSE event, JSON-parsed except `[DONE]`).
const encode = (events: ReadonlyArray<Emission>): Effect.Effect<ReadonlyArray<unknown>> =>
  Stream.fromIterable(events).pipe(
    toUIMessageStream("m1"),
    Stream.runCollect,
    Effect.map((sse) => sse.map((e) => (e.data === "[DONE]" ? "[DONE]" : JSON.parse(e.data)))),
  )

const types = (parts: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  parts.map((p) => (p === "[DONE]" ? "[DONE]" : (p as { type: string }).type))

describe("toUIMessageStream", () => {
  it.effect("brackets text deltas with start / text-start / text-end / finish / [DONE]", () =>
    Effect.gen(function* () {
      const parts = yield* encode([
        Turn.TurnEvent.TextDelta({ text: "Hel" }),
        Turn.TurnEvent.TextDelta({ text: "lo" }),
        Turn.TurnEvent.TurnComplete({ turn: turn([Items.assistantText("Hello")], "stop") }),
      ])

      expect(types(parts)).toEqual([
        "start",
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "finish",
        "[DONE]",
      ])
      expect(parts[0]).toEqual({ type: "start", messageId: "m1" })
      // Both deltas share the one synthesized block id.
      const id = (parts[1] as { id: string }).id
      expect((parts[2] as { id: string }).id).toBe(id)
      expect((parts[4] as { id: string }).id).toBe(id)
    }),
  )

  it.effect("maps a tool round-trip to input-start/delta/available then output-available", () =>
    Effect.gen(function* () {
      const call: Items.ToolCall = {
        type: "function_call",
        call_id: "c1",
        name: "search",
        arguments: `{"q":"lisbon"}`,
      }
      const parts = yield* encode([
        Turn.TurnEvent.ToolCallStart({ call_id: "c1", name: "search" }),
        Turn.TurnEvent.ToolCallArgsDelta({ call_id: "c1", delta: `{"q":"lisbon"}` }),
        Turn.TurnEvent.TurnComplete({ turn: turn([call], "tool_calls") }),
        { type: "function_call_output", call_id: "c1", output: [Items.json({ hits: 3 })] },
      ])

      expect(types(parts)).toEqual([
        "start",
        "tool-input-start",
        "tool-input-delta",
        "tool-input-available",
        "tool-output-available",
        "finish",
        "[DONE]",
      ])
      // JSON payloads are decoded, not passed through as strings.
      expect(parts[3]).toEqual({
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "search",
        input: { q: "lisbon" },
      })
      expect(parts[4]).toEqual({
        type: "tool-output-available",
        toolCallId: "c1",
        output: { hits: 3 },
      })
    }),
  )

  it.effect("maps a failed call to tool-output-error and media to a data URL", () =>
    Effect.gen(function* () {
      const parts = yield* encode([
        {
          type: "function_call_output",
          call_id: "c1",
          output: [Items.json({ _tag: "CityNotFound", city: "Atlantis" })],
          isError: true,
        },
        {
          type: "function_call_output",
          call_id: "c2",
          output: [
            Items.text("Home"),
            Items.image({ _tag: "bytes", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }),
          ],
        },
      ])
      expect(parts.slice(1, 3)).toEqual([
        {
          type: "tool-output-error",
          toolCallId: "c1",
          errorText: '{"_tag":"CityNotFound","city":"Atlantis"}',
        },
        {
          type: "tool-output-available",
          toolCallId: "c2",
          output: ["Home", { type: "image", url: "data:image/png;base64,AQID" }],
        },
      ])
    }),
  )

  it.effect("surfaces a refusal as an error part", () =>
    Effect.gen(function* () {
      const parts = yield* encode([Turn.TurnEvent.RefusalDelta({ text: "cannot help" })])
      expect(types(parts)).toEqual(["start", "error", "finish", "[DONE]"])
      expect(parts[1]).toEqual({ type: "error", errorText: "cannot help" })
    }),
  )

  it.effect("interleaves data-part and message-metadata emissions", () =>
    Effect.gen(function* () {
      const parts = yield* encode([
        dataPart("metrics", { tokps: 42 }, { transient: true }),
        Turn.TurnEvent.TextDelta({ text: "hi" }),
        messageMetadata({ model: "gpt-5.4-mini", usage: { output_tokens: 7 } }),
        Turn.TurnEvent.TurnComplete({ turn: turn([Items.assistantText("hi")], "stop") }),
      ])

      expect(types(parts)).toEqual([
        "start",
        "data-metrics",
        "text-start",
        "text-delta",
        "message-metadata",
        "text-end",
        "finish",
        "[DONE]",
      ])
      expect(parts[1]).toEqual({ type: "data-metrics", data: { tokps: 42 }, transient: true })
      expect(parts[4]).toEqual({
        type: "message-metadata",
        messageMetadata: { model: "gpt-5.4-mini", usage: { output_tokens: 7 } },
      })
    }),
  )
})

describe("decodeMessages", () => {
  it("folds UIMessage text parts back into HistoryItems by role", () => {
    const items = decodeMessages([
      { role: "system", parts: [{ type: "text", text: "be terse" }] },
      {
        role: "user",
        parts: [
          { type: "text", text: "hi " },
          { type: "text", text: "there" },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ])

    expect(items).toEqual([
      Items.systemText("be terse"),
      Items.userText("hi there"),
      Items.assistantText("hello"),
    ])
  })

  it("folds an image file part into an input_image block and drops non-image files", () => {
    const items = decodeMessages([
      {
        role: "user",
        parts: [
          { type: "text", text: "look", state: "done" },
          { type: "file", mediaType: "image/png", url: "https://x/i.png", filename: "i.png" },
          { type: "file", mediaType: "application/pdf", url: "https://x/doc.pdf" },
        ],
      },
    ])

    expect(items).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          { type: "input_image", source: Image.imageUrl("https://x/i.png", "image/png") },
        ],
      },
    ])
  })

  it("expands an assistant tool call into function_call + function_call_output", () => {
    const items = decodeMessages([
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Here", state: "done" },
          {
            type: "tool-search",
            toolCallId: "c1",
            state: "output-available",
            input: { q: "lisbon" },
            output: { hits: 3 },
            providerExecuted: false,
          },
        ],
      },
    ])

    expect(items).toEqual([
      Items.assistantText("Here"),
      { type: "function_call", call_id: "c1", name: "search", arguments: `{"q":"lisbon"}` },
      // The output stays a value; the provider codec serializes it.
      { type: "function_call_output", call_id: "c1", output: [Items.json({ hits: 3 })] },
    ])
  })

  it("emits only function_call for a dynamic tool with no resolved output", () => {
    const items = decodeMessages([
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "lookup",
            toolCallId: "c9",
            state: "input-available",
            input: { id: 7 },
          },
        ],
      },
    ])

    expect(items).toEqual([
      { type: "function_call", call_id: "c9", name: "lookup", arguments: `{"id":7}` },
    ])
  })
})
