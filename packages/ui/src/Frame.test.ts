import { describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { expect } from "vitest"
import * as Frame from "./Frame.js"
import * as Run from "./Run.js"
import { RunId, StreamId } from "./RunEvent.js"

const Say = Schema.Struct({ text: Schema.String })

describe("Frame", () => {
  it.effect("media carries its channel as a big-endian u16 in front of the payload", () =>
    Effect.gen(function* () {
      const wire = yield* Frame.encode(Say)(Frame.media(513, new Uint8Array([7, 8])))
      expect(wire).toEqual(new Uint8Array([2, 1, 7, 8]))
      const back = yield* Frame.decode(Say)(wire)
      expect(back).toEqual(Frame.media(513, new Uint8Array([7, 8])))
    }),
  )

  it.effect("a message is JSON text through the codec", () =>
    Effect.gen(function* () {
      const wire = yield* Frame.encode(Say)(Frame.message({ text: "hi" }))
      expect(wire).toBe('{"text":"hi"}')
      expect(yield* Frame.decode(Say)(wire)).toEqual(Frame.message({ text: "hi" }))
    }),
  )

  it.effect("binary shorter than the channel header is not a frame", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Frame.decode(Say)(new Uint8Array([1])))
      expect(error._tag).toBe("FrameError")
    }),
  )

  it.effect("sequence numbers messages and passes media through without a seq", () =>
    Effect.gen(function* () {
      const runId = RunId.make("r1")
      const frames = yield* Stream.make<ReadonlyArray<Frame.Frame<Run.Owned>>>(
        Frame.message({ event: { type: "live", name: "vad", value: true } }),
        Frame.media(0, new Uint8Array([1])),
        Frame.message({ runId, event: { type: "text-delta", text: "a" } }),
      ).pipe(Frame.sequence(StreamId.make("s")), Stream.runCollect)

      expect(frames).toEqual([
        Frame.message({
          streamId: "s",
          seq: 1,
          event: { type: "live", name: "vad", value: true },
        }),
        Frame.media(0, new Uint8Array([1])),
        Frame.message({ streamId: "s", seq: 2, runId, event: { type: "text-delta", text: "a" } }),
      ])
    }),
  )
})
