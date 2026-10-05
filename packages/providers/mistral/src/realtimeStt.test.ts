import { describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { streamTranscription } from "./realtimeStt.js"

const pcm = { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const

const request = { model: "voxtral-mini-transcribe-realtime-2602", inputFormat: pcm }

const sessionCreated = {
  type: "session.created",
  session: { request_id: "req_1", model: request.model },
}

const delta = (text: string) => ({ type: "transcription.text.delta", text })

const start = <E>(
  server: FakeWebSocket.FakeWebSocketServer,
  audioIn: Stream.Stream<Uint8Array, E>,
) =>
  streamTranscription({ apiKey: Redacted.make("test-key"), webSocket: server.connect })(
    audioIn,
    request,
  ).pipe(Stream.runCollect, Effect.exit, Effect.forkChild)

/** Run a transcription against `server`, closing it, if asked, once the frames are in. */
const transcribe = <E>(
  server: FakeWebSocket.FakeWebSocketServer,
  audioIn: Stream.Stream<Uint8Array, E>,
  close?: { readonly code: number; readonly afterSent?: number },
) =>
  Effect.gen(function* () {
    const collector = yield* start(server, audioIn)
    if (close !== undefined) {
      yield* server.greeted
      yield* server.awaitSent(close.afterSent ?? 0)
      yield* server.close(close.code)
    }
    return yield* Fiber.join(collector)
  })

describe("Mistral Realtime STT socket", () => {
  it.live("configures the session before any audio, and ends on a clean close", () =>
    Effect.gen(function* () {
      const server = yield* FakeWebSocket.make({
        greeting: [
          sessionCreated,
          delta("hel"),
          delta("lo"),
          { type: "transcription.done", text: "hello", model: request.model, segments: [] },
          { type: "error", error: { message: "slow down", code: 3001 } },
        ],
      })
      const exit = yield* transcribe(server, Stream.make(new Uint8Array([1, 2])), {
        code: 1000,
        afterSent: 3,
      })

      expect(exit).toEqual(
        Exit.succeed([
          { _tag: "partial", text: "hel" },
          { _tag: "partial", text: "hello" },
          { _tag: "final", text: "hello" },
          { _tag: "error", code: "3001", message: "slow down" },
        ]),
      )
      const sent = (yield* server.sent) as ReadonlyArray<{ type: string }>
      expect(sent.map((f) => f.type)).toEqual([
        "session.update",
        "input_audio.append",
        "input_audio.end",
      ])
    }).pipe(Effect.scoped),
  )

  it.live("fails rather than ending when the connection drops", () =>
    Effect.gen(function* () {
      const server = yield* FakeWebSocket.make({ greeting: [sessionCreated] })
      const exit = yield* transcribe(server, Stream.never, { code: 1011 })

      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("Unavailable")
    }).pipe(Effect.scoped),
  )

  it.live("fails with the audio input's own error", () =>
    Effect.gen(function* () {
      const server = yield* FakeWebSocket.make({ greeting: [sessionCreated] })
      const exit = yield* transcribe(server, Stream.fail("microphone unplugged"))

      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("microphone unplugged")
    }).pipe(Effect.scoped),
  )

  it.effect("commits a synthetic final once the deltas go quiet", () =>
    Effect.gen(function* () {
      const server = yield* FakeWebSocket.make({
        greeting: [sessionCreated, delta("hel"), delta("lo ")],
      })
      const collector = yield* start(server, Stream.never)
      yield* server.greeted
      yield* TestClock.withLive(Effect.sleep("5 millis"))
      yield* TestClock.adjust("1 second")
      yield* server.close(1000)

      expect(yield* Fiber.join(collector)).toEqual(
        Exit.succeed([
          { _tag: "partial", text: "hel" },
          { _tag: "partial", text: "hello " },
          { _tag: "final", text: "hello" },
        ]),
      )
    }).pipe(Effect.scoped),
  )
})
