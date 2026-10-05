import { describe, it } from "@effect/vitest"
import { Effect, Exit, Pull, Queue, Schema } from "effect"
import * as Socket from "effect/socket/Socket"
import { expect } from "vitest"
import * as AiError from "../domain/AiError.js"
import * as FakeWebSocket from "../testing/FakeWebSocket.js"
import { open, toAiError } from "./WebSocketSession.js"

const KEY = "AIzaSyEXAMPLEKEY"
const URL = `wss://generativelanguage.googleapis.com/ws/BidiGenerateContent?key=${KEY}`

/**
 * What Bun hands the `error` listener when the upgrade is rejected: the whole
 * socket URL, in prose, on a prototype getter. Node and Deno say less, but the
 * adapter cannot know which runtime it is on.
 */
class BunErrorEvent {
  get message(): string {
    return `WebSocket connection to '${URL}' failed: Connection ended`
  }
}

/** Deno names the status but not the URL, also on a prototype getter. */
class DenoErrorEvent {
  constructor(private readonly detail: string) {}
  get message(): string {
    return `NetworkError: failed to connect to WebSocket: ${this.detail}`
  }
}

const openFailure = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })

describe("WebSocketSession errors", () => {
  it("keeps the key out of the error a rejected upgrade produces", () => {
    const error = toAiError("google")(openFailure(new BunErrorEvent()))

    expect(JSON.stringify(error)).not.toContain(KEY)
    expect(AiError.describe(error)).not.toContain(KEY)
    // The host is still there: an error that says nothing is its own problem.
    expect(JSON.stringify(error)).toContain("generativelanguage.googleapis.com")
  })

  it("reads the rejected status out of the prose, wherever the runtime put it", () => {
    // Deno's wording. The status is the only hint a rejected upgrade gives.
    const forbidden = toAiError("google")(
      openFailure(new DenoErrorEvent("Invalid status code: 403")),
    )
    const ended = toAiError("google")(openFailure(new BunErrorEvent()))

    expect(forbidden._tag).toBe("AuthFailed")
    expect(ended._tag).toBe("Unavailable")
  })
})

const Frame = Schema.Struct({ n: Schema.Number })

const session = (server: FakeWebSocket.FakeWebSocketServer) =>
  open({ url: "wss://example.test", provider: "test", schema: Frame }).pipe(
    Effect.provide(server.layer),
  )

describe("WebSocketSession lifetime", () => {
  it.live("writes a reply to a frame before the next one arrives", () =>
    Effect.gen(function* () {
      const server = yield* FakeWebSocket.make({ greeting: [{ n: 1 }] })
      const { send, frames } = yield* session(server)

      const first = yield* Queue.take(frames)
      yield* send(JSON.stringify({ n: first.n + 1 }))
      yield* Effect.sleep("5 millis")

      expect(yield* server.sent).toEqual([{ n: 2 }])
    }).pipe(Effect.scoped),
  )

  it.live("ends the frames on a clean close, and refuses a send after it", () =>
    Effect.gen(function* () {
      const server = yield* FakeWebSocket.make({ greeting: [{ n: 1 }] })
      const { send, frames } = yield* session(server)

      yield* Queue.take(frames)
      yield* server.close(1000)
      const end = yield* Effect.exit(Queue.take(frames))
      const late = yield* Effect.exit(send(JSON.stringify({ n: 2 })))

      expect(Exit.isFailure(end) && Pull.isDoneCause(end.cause)).toBe(true)
      expect(Exit.isFailure(late) && JSON.stringify(late)).toContain("Unavailable")
    }).pipe(Effect.scoped),
  )

  it.live("fails the frames on a dirty close", () =>
    Effect.gen(function* () {
      const server = yield* FakeWebSocket.make({ greeting: [{ n: 1 }] })
      const { frames } = yield* session(server)

      yield* Queue.take(frames)
      yield* server.close(1011)
      const end = yield* Effect.exit(Queue.take(frames))

      expect(JSON.stringify(end)).toContain("Unavailable")
    }).pipe(Effect.scoped),
  )
})
