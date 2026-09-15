import { describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { expect, expectTypeOf } from "vitest"
import type * as AiError from "../domain/AiError.js"
import { imageBase64 } from "../domain/Image.js"
import { type CommonSessionRequest, RealtimeEvent, RealtimeInput } from "../domain/Realtime.js"
import * as MockRealtimeSession from "../testing/MockRealtimeSession.js"
import { RealtimeVideoInput, open, sendVideoFrame, toolCalls } from "./RealtimeSession.js"

const pcm = { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } as const

const request: CommonSessionRequest = {
  model: "gpt-realtime-2.1",
  inputFormat: pcm,
  outputFormat: pcm,
}

const call = {
  type: "function_call",
  call_id: "call_1",
  name: "get_time",
  arguments: "{}",
} as const

describe("RealtimeSession against a scripted session", () => {
  it.effect("answers each input and ends `events` when the scope closes", () =>
    Effect.gen(function* () {
      const mock = MockRealtimeSession.layer({
        initial: [RealtimeEvent.ResponseStarted({ responseId: "r1" })],
        onInput: (input) =>
          RealtimeInput.$is("Audio")(input)
            ? [RealtimeEvent.AudioDelta({ responseId: "r1", bytes: new Uint8Array([7]) })]
            : [RealtimeEvent.ResponseDone({ responseId: "r1", reason: "interrupted" })],
      })

      const handle = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* open(request)
          yield* handle.send(RealtimeInput.Audio({ bytes: new Uint8Array([1, 2]) }))
          yield* handle.send(RealtimeInput.Interrupt())
          return handle
        }),
      ).pipe(Effect.provide(mock.layer))

      // The scope is closed, so the stream drains what is queued and ends
      // rather than hanging.
      const events = yield* Stream.runCollect(handle.events)
      expect(events).toEqual([
        RealtimeEvent.ResponseStarted({ responseId: "r1" }),
        RealtimeEvent.AudioDelta({ responseId: "r1", bytes: new Uint8Array([7]) }),
        RealtimeEvent.ResponseDone({ responseId: "r1", reason: "interrupted" }),
      ])

      const recorder = yield* mock.recorder
      expect(recorder.openCalls.map((r) => r.model)).toEqual(["gpt-realtime-2.1"])
      expect(recorder.sent.map((i) => i._tag)).toEqual(["Audio", "Interrupt"])
    }),
  )

  it.effect("narrows `toolCalls` to the calls the model made", () =>
    Effect.gen(function* () {
      const mock = MockRealtimeSession.layer({
        initial: [
          RealtimeEvent.ResponseStarted({ responseId: "r1" }),
          RealtimeEvent.ToolCall({ responseId: "r1", call }),
          RealtimeEvent.OutputTranscriptDelta({ responseId: "r1", text: "one moment" }),
        ],
      })

      const handle = yield* Effect.scoped(open(request)).pipe(Effect.provide(mock.layer))
      const calls = yield* Stream.runCollect(toolCalls(handle.events))

      expect(calls.map((e) => e.call.call_id)).toEqual(["call_1"])
    }),
  )
})

describe("RealtimeVideoInput marker", () => {
  const frame = imageBase64("aW1n", "image/jpeg")

  it("leaves the marker unsatisfied against an audio-only Layer", () => {
    const mock = MockRealtimeSession.layerAudioOnly({})
    const program = Effect.scoped(
      Effect.flatMap(open(request), (handle) => sendVideoFrame(handle, frame)),
    ).pipe(Effect.provide(mock.layer))

    // `RealtimeSession` is provided, `RealtimeVideoInput` is not, so running
    // this would be a type error.
    expectTypeOf(program).toEqualTypeOf<Effect.Effect<void, AiError.AiError, RealtimeVideoInput>>()
  })

  it("clears R to never against a Layer that ships the marker", () => {
    const mock = MockRealtimeSession.layer({})
    const program = Effect.scoped(
      Effect.flatMap(open(request), (handle) => sendVideoFrame(handle, frame)),
    ).pipe(Effect.provide(mock.layer))

    expectTypeOf(program).toEqualTypeOf<Effect.Effect<void, AiError.AiError, never>>()
  })
})
