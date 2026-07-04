/**
 * Conformance against the AI SDK's own client reader. We encode an
 * InteractionEvent script, strip the SSE framing, and hand the raw chunks to
 * `readUIMessageStream` - the same assembly `useChat` runs in the browser -
 * then assert the reconstructed `UIMessage`. This pins the encoder to the
 * real protocol implementation: a future SDK bump our bytes no longer satisfy
 * fails here rather than in someone's app.
 */
import * as Items from "@effect-uai/core/Items"
import * as Turn from "@effect-uai/core/Turn"
import { describe, it } from "@effect/vitest"
import {
  isTextUIPart,
  isToolUIPart,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import { Array as Arr, Effect, Option, Stream } from "effect"
import { expect } from "vitest"
import { toUIMessageStream } from "./UIMessageStream.js"

const turn = (items: ReadonlyArray<Items.HistoryItem>, stop: Items.StopReason): Turn.Turn => ({
  items,
  usage: {},
  stop_reason: stop,
})

// Encode the script, drop the `[DONE]` terminator, parse each part back into a
// chunk, and feed them through the AI SDK reader - yielding the final message.
const reconstruct = (
  events: ReadonlyArray<Turn.InteractionEvent>,
): Effect.Effect<Option.Option<UIMessage>> => {
  const chunks = Stream.fromIterable(events).pipe(
    toUIMessageStream("m1"),
    Stream.map((e) => e.data),
    Stream.filter((data) => data !== "[DONE]"),
    Stream.map((data) => JSON.parse(data) as UIMessageChunk),
  )
  const stream = Stream.toReadableStream(chunks)
  return Stream.fromAsyncIterable(readUIMessageStream({ stream }), (cause) => cause).pipe(
    Stream.runLast,
    Effect.orDie,
  )
}

const textOf = (message: UIMessage): string =>
  message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join("")

describe("AI SDK conformance (readUIMessageStream)", () => {
  it.effect("reconstructs assistant text", () =>
    Effect.gen(function* () {
      const message = yield* reconstruct([
        Turn.TurnEvent.TextDelta({ text: "Hel" }),
        Turn.TurnEvent.TextDelta({ text: "lo" }),
        Turn.TurnEvent.TurnComplete({ turn: turn([Items.assistantText("Hello")], "stop") }),
      ])

      expect(Option.map(message, (m) => m.role)).toEqual(Option.some("assistant"))
      expect(Option.map(message, textOf)).toEqual(Option.some("Hello"))
    }),
  )

  it.effect("reconstructs a tool call with its resolved output", () =>
    Effect.gen(function* () {
      const call: Items.ToolCall = {
        type: "function_call",
        call_id: "c1",
        name: "search",
        arguments: `{"q":"lisbon"}`,
      }
      const message = yield* reconstruct([
        Turn.TurnEvent.ToolCallStart({ call_id: "c1", name: "search" }),
        Turn.TurnEvent.ToolCallArgsDelta({ call_id: "c1", delta: `{"q":"lisbon"}` }),
        Turn.TurnEvent.TurnComplete({ turn: turn([call], "tool_calls") }),
        Items.toolCallOutput("c1", `{"hits":3}`),
      ])

      const tool = Option.flatMap(message, (m) => Arr.findFirst(m.parts, isToolUIPart))

      expect(Option.map(tool, (t) => t.state)).toEqual(Option.some("output-available"))
      expect(
        Option.map(tool, (t) => (t.state === "output-available" ? t.input : undefined)),
      ).toEqual(Option.some({ q: "lisbon" }))
      expect(
        Option.map(tool, (t) => (t.state === "output-available" ? t.output : undefined)),
      ).toEqual(Option.some({ hits: 3 }))
    }),
  )
})
