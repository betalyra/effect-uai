import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { frameToEvent } from "./realtimeStt.js"

const decode = (frame: unknown) => frameToEvent(JSON.stringify(frame))

describe("OpenAI Realtime STT frame mapper", () => {
  it.effect("decodes GA transcript frames and converts VAD offsets from ms to seconds", () =>
    Effect.gen(function* () {
      expect(
        yield* decode({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "item_1",
          content_index: 0,
          delta: "hel",
        }),
      ).toEqual({ _tag: "partial", text: "hel" })
      expect(
        yield* decode({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item_1",
          content_index: 0,
          transcript: "hello",
          usage: { type: "duration", seconds: 1.2 },
        }),
      ).toEqual({ _tag: "final", text: "hello" })
      expect(
        yield* decode({ type: "input_audio_buffer.speech_started", audio_start_ms: 1500 }),
      ).toEqual({ _tag: "speech-started", atSeconds: 1.5 })
      expect(
        yield* decode({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 3200 }),
      ).toEqual({ _tag: "utterance-ended", atSeconds: 3.2 })
    }),
  )

  it.effect("elides a null error code instead of forwarding it", () =>
    Effect.gen(function* () {
      expect(
        yield* decode({
          type: "error",
          error: { type: "invalid_request_error", code: null, message: "bad" },
        }),
      ).toEqual({ _tag: "error", message: "bad" })
    }),
  )

  it.effect("drops handshake acks, unknown frames and malformed text", () =>
    Effect.gen(function* () {
      expect(yield* decode({ type: "session.updated", session: { type: "transcription" } })).toBe(
        undefined,
      )
      expect(yield* decode({ type: "input_audio_buffer.committed", item_id: "i" })).toBe(undefined)
      expect(yield* frameToEvent("not json")).toBe(undefined)
    }),
  )
})
