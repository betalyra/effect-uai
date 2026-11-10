import { describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { type Envelope, RunId, StreamId } from "./RunEvent.js"
import * as SseEncoding from "./SseEncoding.js"

describe("SseEncoding", () => {
  const envelopes: ReadonlyArray<Envelope> = [
    {
      streamId: StreamId.make("s"),
      seq: 1,
      runId: RunId.make("r1"),
      event: { type: "text-delta", text: "two\nlines" },
    },
    {
      streamId: StreamId.make("s"),
      seq: 2,
      event: {
        type: "image",
        image: { _tag: "bytes", bytes: new Uint8Array([1, 2]), mimeType: "image/png" },
      },
    },
  ]

  it.effect("frames id = seq, event = type, and round-trips non-JSON values", () =>
    Effect.gen(function* () {
      const bytes = yield* Stream.fromIterable(envelopes).pipe(
        SseEncoding.encode,
        Stream.runCollect,
      )
      const text = new TextDecoder().decode(Buffer.concat(bytes))
      expect(text).toContain("id: 1\nevent: text-delta\n")
      const decoded = yield* Stream.fromIterable(bytes).pipe(SseEncoding.decode, Stream.runCollect)
      expect(decoded).toEqual(envelopes)
    }),
  )

  it.each([
    { label: "web Headers", headers: new Headers({ "last-event-id": "9" }), seq: Option.some(9) },
    { label: "Effect record headers", headers: { "last-event-id": "7" }, seq: Option.some(7) },
    { label: "no header", headers: new Headers(), seq: Option.none() },
    { label: "a non-integer value", headers: { "last-event-id": "abc" }, seq: Option.none() },
  ])("lastEventId reads $label", ({ headers, seq }) => {
    expect(SseEncoding.lastEventId(headers)).toEqual(seq)
  })

  it.effect("heartbeat interleaves comments, ends with the events, and decodes away", () =>
    Effect.gen(function* () {
      const fiber = yield* Stream.fromIterable(envelopes).pipe(
        Stream.schedule(Schedule.spaced("1 second")),
        SseEncoding.encode,
        SseEncoding.heartbeat("400 millis"),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* TestClock.adjust("3 seconds")
      const bytes = yield* Fiber.join(fiber)
      const text = new TextDecoder().decode(Buffer.concat(bytes))
      expect(text.split(": heartbeat\n\n").length).toBeGreaterThan(2)
      const decoded = yield* Stream.fromIterable(bytes).pipe(SseEncoding.decode, Stream.runCollect)
      expect(decoded).toEqual(envelopes)
    }),
  )
})
