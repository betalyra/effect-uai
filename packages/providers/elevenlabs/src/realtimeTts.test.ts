import { describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Redacted, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { expect } from "vitest"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { streamSynthesis } from "./realtimeTts.js"

const request = { voiceId: "voice-1" }

const synthesizing = FakeWebSocket.make({
  greeting: [
    { audio: Base64.encode(new Uint8Array([1, 2])), isFinal: null },
    { audio: null, isFinal: true },
  ],
})

/** Run a synthesis against `server`, closing it, if asked, once the frames are in. */
const synthesize = <E>(
  server: FakeWebSocket.FakeWebSocketServer,
  textIn: Stream.Stream<string, E>,
  close?: { readonly code: number; readonly afterSent?: number },
) =>
  Effect.gen(function* () {
    const run = streamSynthesis({ apiKey: Redacted.make("test-key") })(textIn, request).pipe(
      Stream.provide(server.layer),
    )
    const collector = yield* Effect.forkChild(Effect.exit(Stream.runCollect(run)))
    if (close !== undefined) {
      yield* server.greeted
      yield* server.awaitSent(close.afterSent ?? 0)
      yield* server.close(close.code)
    }
    return yield* Fiber.join(collector)
  })

describe("ElevenLabs realtime TTS socket", () => {
  it.live("sends BOS before any text and EOS after it, and ends on a clean close", () =>
    Effect.gen(function* () {
      const server = yield* synthesizing
      const exit = yield* synthesize(server, Stream.make("Hello", "", "world "), {
        code: 1000,
        afterSent: 4,
      })

      expect(exit).toEqual(Exit.succeed([{ bytes: new Uint8Array([1, 2]) }]))
      expect(yield* server.sent).toEqual([
        { text: " ", "xi-api-key": "test-key" },
        { text: "Hello " },
        { text: "world " },
        { text: "" },
      ])
    }).pipe(Effect.scoped),
  )

  it.live("fails rather than ending when the connection drops", () =>
    Effect.gen(function* () {
      const server = yield* synthesizing
      const exit = yield* synthesize(server, Stream.never, { code: 1011 })

      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("Unavailable")
    }).pipe(Effect.scoped),
  )

  it.live("fails with the text input's own error", () =>
    Effect.gen(function* () {
      const server = yield* synthesizing
      const exit = yield* synthesize(server, Stream.fail("llm stream broke"))

      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("llm stream broke")
    }).pipe(Effect.scoped),
  )
})
