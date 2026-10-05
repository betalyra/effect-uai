import { describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { expect } from "vitest"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { streamTranscription } from "./realtimeStt.js"

const pcm = { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const

const request = { model: "scribe_v2_realtime", inputFormat: pcm }

/** Hands out a token and signals `issued`, so the test closes only after the connect starts. */
const tokenClient = (issued: Deferred.Deferred<void>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) =>
      Deferred.succeed(issued, undefined).pipe(
        Effect.as(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ token: "t" })))),
      ),
    ),
  )

const transcribing = FakeWebSocket.make({
  greeting: [
    { message_type: "session_started", session_id: "s1" },
    { message_type: "partial_transcript", text: "hel" },
    { message_type: "committed_transcript", text: "hello" },
  ],
})

/** Run a transcription against `server`, closing it, if asked, once the frames are in. */
const transcribe = <E>(
  server: FakeWebSocket.FakeWebSocketServer,
  audioIn: Stream.Stream<Uint8Array, E>,
  close?: { readonly code: number; readonly afterSent?: number },
) =>
  Effect.gen(function* () {
    const issued = yield* Deferred.make<void>()
    const run = streamTranscription({ apiKey: Redacted.make("test-key") })(audioIn, request).pipe(
      Stream.provide(Layer.merge(server.layer, tokenClient(issued))),
    )
    const collector = yield* Effect.forkChild(Effect.exit(Stream.runCollect(run)))
    yield* Deferred.await(issued)
    if (close !== undefined) {
      yield* server.greeted
      yield* server.awaitSent(close.afterSent ?? 0)
      yield* server.close(close.code)
    }
    return yield* Fiber.join(collector)
  })

describe("ElevenLabs realtime STT socket", () => {
  it.live("streams audio chunks, decodes transcripts, and ends on a clean close", () =>
    Effect.gen(function* () {
      const server = yield* transcribing
      const exit = yield* transcribe(server, Stream.make(new Uint8Array([1, 2])), {
        code: 1000,
        afterSent: 1,
      })

      expect(exit).toEqual(
        Exit.succeed([
          { _tag: "partial", text: "hel" },
          { _tag: "final", text: "hello" },
        ]),
      )
      const sent = (yield* server.sent) as ReadonlyArray<{
        message_type: string
        sample_rate: number
      }>
      expect(sent).toMatchObject([{ message_type: "input_audio_chunk", sample_rate: 16000 }])
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
