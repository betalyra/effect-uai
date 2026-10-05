import { describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Redacted, Stream } from "effect"
import { expect } from "vitest"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { frameToEvent, streamTranscription } from "./realtimeStt.js"

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

const pcm = { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } as const

const request = { model: "gpt-4o-transcribe", inputFormat: pcm }

const transcribing = FakeWebSocket.make({
  greeting: [
    { type: "conversation.item.input_audio_transcription.delta", delta: "hel" },
    { type: "conversation.item.input_audio_transcription.completed", transcript: "hello" },
  ],
})

/** Run a transcription against `server`, closing it, if asked, once the frames are in. */
const transcribe = <E>(
  server: FakeWebSocket.FakeWebSocketServer,
  audioIn: Stream.Stream<Uint8Array, E>,
  close?: { readonly code: number; readonly afterSent?: number },
) =>
  Effect.gen(function* () {
    const run = streamTranscription({
      apiKey: Redacted.make("test-key"),
      webSocket: server.connect,
    })
    const collector = yield* Effect.forkChild(Effect.exit(Stream.runCollect(run(audioIn, request))))
    if (close !== undefined) {
      yield* server.greeted
      yield* server.awaitSent(close.afterSent ?? 0)
      yield* server.close(close.code)
    }
    return yield* Fiber.join(collector)
  })

describe("OpenAI Realtime STT socket", () => {
  it.live("configures the session before any audio, and ends on a clean close", () =>
    Effect.gen(function* () {
      const server = yield* transcribing
      const exit = yield* transcribe(server, Stream.make(new Uint8Array([1, 2])), {
        code: 1000,
        afterSent: 2,
      })

      expect(exit).toEqual(
        Exit.succeed([
          { _tag: "partial", text: "hel" },
          { _tag: "final", text: "hello" },
        ]),
      )
      const sent = (yield* server.sent) as ReadonlyArray<{ type: string }>
      expect(sent.map((f) => f.type)).toEqual(["session.update", "input_audio_buffer.append"])
    }).pipe(Effect.scoped),
  )

  it.live("fails rather than ending when the connection drops", () =>
    Effect.gen(function* () {
      const server = yield* transcribing
      const exit = yield* transcribe(server, Stream.never, { code: 1011 })

      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("Unavailable")
    }).pipe(Effect.scoped),
  )

  it.live("fails with the audio input's own error", () =>
    Effect.gen(function* () {
      const server = yield* transcribing
      const exit = yield* transcribe(server, Stream.fail("microphone unplugged"))

      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("microphone unplugged")
    }).pipe(Effect.scoped),
  )
})
