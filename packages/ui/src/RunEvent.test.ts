import { describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as RunEvent from "./RunEvent.js"

const Wire = Schema.fromJsonString(RunEvent.EnvelopeJson)
const encode = Schema.encodeEffect(Wire)
const decode = Schema.decodeUnknownEffect(Wire)

const r1 = RunEvent.RunId.make("r1")

const envelope = (seq: number, event: RunEvent.RunEvent): RunEvent.Envelope => ({
  streamId: RunEvent.StreamId.make("st_1"),
  seq,
  runId: r1,
  event,
})

describe("RunEvent wire codec", () => {
  it.effect.each([
    {
      label: "run-started",
      frame: envelope(1, {
        type: "run-started",
        runId: r1,
        messageId: "m1",
        inputs: [RunEvent.InputId.make("in_1")],
        protocol: 1,
      }),
    },
    {
      label: "tool-call-ready",
      frame: envelope(2, {
        type: "tool-call-ready",
        callId: "c1",
        name: "get_weather",
        input: { city: "Lisbon" },
      }),
    },
    {
      label: "image bytes",
      frame: envelope(3, {
        type: "image",
        image: { _tag: "bytes", bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" },
      }),
    },
    {
      label: "object-delta patch",
      frame: envelope(4, {
        type: "object-delta",
        id: "o1",
        patch: [{ op: "add", path: "/items/-", value: "eggs" }],
      }),
    },
    {
      label: "run-completed",
      frame: envelope(5, { type: "run-completed", metadata: { usage: { input_tokens: 10 } } }),
    },
  ])("round-trips $label through JSON", ({ frame }) =>
    encode(frame).pipe(
      Effect.flatMap(decode),
      Effect.map((decoded) => expect(decoded).toEqual(frame)),
    ),
  )

  it.effect.each([
    { label: "an unknown event type", frame: { streamId: "s", seq: 1, event: { type: "nope" } } },
    {
      label: "another protocol version",
      frame: {
        streamId: "s",
        seq: 1,
        event: { type: "run-started", runId: "r1", messageId: "m1", inputs: [], protocol: 2 },
      },
    },
    {
      label: "a seq below 1",
      frame: { streamId: "s", seq: 0, event: { type: "text-delta", text: "hi" } },
    },
  ])("rejects $label", ({ frame }) =>
    Effect.exit(decode(JSON.stringify(frame))).pipe(
      Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
    ),
  )
})
