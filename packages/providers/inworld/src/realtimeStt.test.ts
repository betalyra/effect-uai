import { describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Redacted, Stream } from "effect"
import { expect } from "vitest"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { streamTranscription } from "./realtimeStt.js"

const pcm = { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const

const request = { model: "inworld/inworld-stt-1", inputFormat: pcm }

const transcribing = FakeWebSocket.make({
  greeting: [
    { result: { speechStarted: { startTimeMs: 1500 } } },
    { result: { transcription: { transcript: "hel", isFinal: false } } },
    { result: { transcription: { transcript: "hello", isFinal: true } } },
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

describe("Inworld Realtime STT socket", () => {
  it.live("sends the config before any audio, and ends on a clean close", () =>
    Effect.gen(function* () {
      const server = yield* transcribing
      const exit = yield* transcribe(server, Stream.make(new Uint8Array([1, 2])), {
        code: 1000,
        afterSent: 4,
      })

      expect(exit).toEqual(
        Exit.succeed([
          { _tag: "speech-started", atSeconds: 1.5 },
          { _tag: "partial", text: "hel" },
          { _tag: "final", text: "hello" },
        ]),
      )
      const sent = (yield* server.sent) as ReadonlyArray<Record<string, unknown>>
      expect(sent.map((f) => Object.keys(f)[0])).toEqual([
        "transcribeConfig",
        "audioChunk",
        "endTurn",
        "closeStream",
      ])
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
