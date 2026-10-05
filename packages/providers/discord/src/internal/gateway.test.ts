import { it as effect } from "@effect/vitest"
import { Effect, Layer, Queue, Redacted } from "effect"
import * as Socket from "effect/socket/Socket"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { describe, expect, it } from "vitest"
import { classifyClose, closeReason, connect } from "./gateway.js"

describe("classifyClose", () => {
  it("never retries a close reconnecting cannot fix", () => {
    expect([4004, 4010, 4011, 4012, 4013, 4014].map(classifyClose)).toEqual(Array(6).fill("fatal"))
  })

  it("identifies fresh only where the session itself is gone", () => {
    expect([4007, 4009].map(classifyClose)).toEqual(["reidentify", "reidentify"])
  })

  it("resumes on everything else, transport drops included", () => {
    // 1006 is a dropped connection, 4000 the code the zombie check sends.
    expect([4000, 4003, 4005, 4008, 1006, 1011].map(classifyClose)).toEqual(Array(6).fill("resume"))
  })
})

describe("closeReason", () => {
  it("names a fatal code, since Discord's close frames carry no reason", () => {
    expect(closeReason(4014, "")).toContain("privileged intent")
  })

  it("falls back to whatever the socket reported", () => {
    expect(closeReason(1006, "connection reset")).toBe("connection reset")
  })
})

const cfg = { token: Redacted.make("token"), intents: 0, url: "wss://gateway.test" }

// Long enough that no heartbeat lands mid-test.
const HELLO = { op: 10, d: { heartbeat_interval: 3_600_000 } }

const READY = {
  op: 0,
  t: "READY",
  s: 1,
  d: {
    user: { id: "1", username: "bot" },
    session_id: "session",
    resume_gateway_url: "wss://resume.test",
  },
}

// Identify gets READY, resume gets RESUMED.
const answers: Record<number, ReadonlyArray<unknown>> = {
  2: [READY],
  6: [{ op: 0, t: "RESUMED", s: 2 }],
}

const gateway = FakeWebSocket.make({
  greeting: [HELLO],
  reply: (frame) => Effect.succeed(answers[(frame as { op: number }).op] ?? []),
})

/** One fake per connection, in dial order; the last one takes any extra dials. */
const dialing = (servers: ReadonlyArray<FakeWebSocket.FakeWebSocketServer>) => {
  const urls: Array<string> = []
  const layer = Layer.succeed(Socket.WebSocketConstructor)((url, protocols) => {
    const server = servers[Math.min(urls.length, servers.length - 1)]!
    urls.push(url)
    return server.connect(url, protocols)
  })
  return { urls, layer }
}

describe("gateway close handling", () => {
  effect.live.each([1000, 4000])("resumes on the resume host after a %i close", (code) =>
    Effect.gen(function* () {
      const first = yield* gateway
      const second = yield* gateway
      const { urls, layer } = dialing([first, second])
      const session = yield* connect(cfg).pipe(Effect.provide(layer))
      expect(session.bot.username).toBe("bot")

      yield* first.close(code)
      yield* second.awaitSent(1)

      expect(urls[1]).toMatch(/^wss:\/\/resume\.test\//)
      expect(yield* second.sent).toEqual([
        { op: 6, d: { token: "token", session_id: "session", seq: 1 } },
      ])
    }),
  )

  effect.live("fails the dispatches on a fatal close after READY", () =>
    Effect.gen(function* () {
      const server = yield* gateway
      const session = yield* connect(cfg).pipe(Effect.provide(dialing([server]).layer))

      yield* server.close(4014)
      const error = yield* Queue.take(session.dispatches).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "MessengerTransportClosed", raw: { code: 4014 } })
    }),
  )

  effect.live("fails the connect on a fatal close before READY", () =>
    Effect.gen(function* () {
      const server = yield* FakeWebSocket.make({ greeting: [HELLO] })
      yield* server.awaitSent(1).pipe(Effect.andThen(server.close(4004)), Effect.forkScoped)

      const error = yield* connect(cfg).pipe(Effect.provide(dialing([server]).layer), Effect.flip)

      expect(error._tag).toBe("MessengerConnectFailed")
      expect(error.reason).toContain("authentication failed")
    }),
  )
})
