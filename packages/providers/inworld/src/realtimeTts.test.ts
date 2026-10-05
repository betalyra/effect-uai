import { describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Redacted, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { expect } from "vitest"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { streamSynthesis } from "./realtimeTts.js"

const request = { model: "inworld-tts-2", voiceId: "Ashley" } as const

const synthesizing = FakeWebSocket.make({
  greeting: [
    { result: { contextCreated: {} } },
    { result: { audioChunk: { audioContent: Base64.encode(new Uint8Array([1, 2, 3])) } } },
    { error: { message: "transient" } },
    { result: { audioChunk: { audioContent: "" } } },
    { result: { contextClosed: {} } },
  ],
})

/** Run a synthesis against `server`, closing it, if asked, once the frames are in. */
const synthesize = <E>(
  server: FakeWebSocket.FakeWebSocketServer,
  textIn: Stream.Stream<string, E>,
  close?: { readonly code: number; readonly afterSent?: number },
) =>
  Effect.gen(function* () {
    const run = streamSynthesis({ apiKey: Redacted.make("test-key"), webSocket: server.connect })
    const collector = yield* Effect.forkChild(Effect.exit(Stream.runCollect(run(textIn, request))))
    if (close !== undefined) {
      yield* server.greeted
      yield* server.awaitSent(close.afterSent ?? 0)
      yield* server.close(close.code)
    }
    return yield* Fiber.join(collector)
  })

describe("Inworld Realtime TTS socket", () => {
  it.live("creates the context before any text, and ends on a clean close", () =>
    Effect.gen(function* () {
      const server = yield* synthesizing
      const exit = yield* synthesize(server, Stream.make("Hello", "", " world"), {
        code: 1000,
        afterSent: 4,
      })

      expect(exit).toEqual(Exit.succeed([{ bytes: new Uint8Array([1, 2, 3]) }]))
      const sent = (yield* server.sent) as ReadonlyArray<Record<string, unknown>>
      expect(sent.map((f) => Object.keys(f)[0])).toEqual([
        "create",
        "send_text",
        "send_text",
        "close_context",
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
      const exit = yield* synthesize(server, Stream.fail("upstream llm failed"))

      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("upstream llm failed")
    }).pipe(Effect.scoped),
  )
})
