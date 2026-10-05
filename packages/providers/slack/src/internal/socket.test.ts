import { it as effect } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Queue, Ref } from "effect"
import * as Socket from "effect/socket/Socket"
import { describe, expect, it } from "vitest"
import * as MessengerError from "@effect-uai/core/MessengerError"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { classifyDisconnect, connect, remember } from "./socket.js"

const command = (envelopeId: string) => ({
  type: "slash_commands",
  envelope_id: envelopeId,
  payload: { channel_id: "C1", user_id: "U1", command: "/ping" },
})

/** Each connection dials its own single-use URL, so each gets its own fake server. */
const slack = (connections: number) =>
  Effect.gen(function* () {
    const servers = yield* Effect.forEach(Array.from({ length: connections }), () =>
      FakeWebSocket.make({ greeting: [{ type: "hello" }] }),
    )
    const opened = yield* Ref.make(0)
    const open = Ref.modify(opened, (n): [string, number] => [`wss://slack.test/${n}`, n + 1])
    const dial: Socket.WebSocketConstructor["Service"] = (url, protocols) =>
      servers[Number(url.split("/").pop())]!.connect(url, protocols)
    const session = yield* connect({ open }).pipe(
      Effect.provide(Layer.succeed(Socket.WebSocketConstructor, dial)),
    )
    return { servers, opened: Ref.get(opened), session }
  })

describe("classifyDisconnect", () => {
  it("ends only on the reason Slack says not to retry", () => {
    expect(classifyDisconnect("link_disabled")).toBe("fatal")
    // A rolling refresh is scheduled, so it reopens without backing off.
    expect(["refresh_requested", "warning"].map(classifyDisconnect)).toEqual(["refresh", "refresh"])
    expect(classifyDisconnect(undefined)).toBe("reconnect")
  })
})

describe("remember", () => {
  it("drops a redelivery of an id still in the set", () => {
    const seen = Option.getOrThrow(remember([], "Ev1"))
    expect(remember(seen, "Ev1")).toEqual(Option.none())
    expect(Option.getOrThrow(remember(seen, "Ev2"))).toEqual(["Ev1", "Ev2"])
  })

  it("forgets the oldest once the set is full, so it cannot grow without bound", () => {
    const full = ["a", "b"]
    expect(Option.getOrThrow(remember(full, "c", 2))).toEqual(["b", "c"])
  })
})

describe("connect", () => {
  effect.live("acknowledges an envelope before handing it on", () =>
    Effect.gen(function* () {
      const { servers, session } = yield* slack(1)
      yield* servers[0]!.push(command("e1"))

      const incoming = yield* Queue.take(session.envelopes)
      expect(incoming.envelope.envelope_id).toBe("e1")
      yield* servers[0]!.awaitSent(1)
      expect(yield* servers[0]!.sent).toEqual([{ envelope_id: "e1" }])
    }).pipe(Effect.scoped),
  )

  effect.live("fails to connect when no URL can be had before hello", () =>
    Effect.gen(function* () {
      const exit = yield* connect({
        open: Effect.fail(
          new MessengerError.MessengerConnectFailed({
            provider: "slack",
            reason: "invalid_auth",
            raw: undefined,
          }),
        ),
      }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.exit)

      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("invalid_auth")
    }).pipe(Effect.scoped),
  )

  // Clean or dirty, a close Slack did not announce is a drop, and every drop reconnects.
  for (const code of [1000, 1006]) {
    effect.live(`reconnects on a fresh URL after a ${code} close`, () =>
      Effect.gen(function* () {
        const { servers, opened, session } = yield* slack(2)
        yield* servers[0]!.close(code)
        yield* servers[1]!.greeted
        yield* servers[1]!.push(command("e2"))

        const incoming = yield* Queue.take(session.envelopes)
        expect(incoming.envelope.envelope_id).toBe("e2")
        expect(yield* opened).toBe(2)
        yield* servers[1]!.awaitSent(1)
        expect(yield* servers[1]!.sent).toEqual([{ envelope_id: "e2" }])
      }).pipe(Effect.scoped),
    )
  }

  effect.live("closes and reconnects on a refresh disconnect", () =>
    Effect.gen(function* () {
      const { servers, opened, session } = yield* slack(2)
      yield* servers[0]!.push({ type: "disconnect", reason: "refresh_requested" })
      yield* servers[1]!.greeted
      yield* servers[1]!.push(command("e3"))

      const incoming = yield* Queue.take(session.envelopes)
      expect(incoming.envelope.envelope_id).toBe("e3")
      expect(yield* opened).toBe(2)
    }).pipe(Effect.scoped),
  )

  effect.live("ends envelopes on a disconnect Slack says not to retry", () =>
    Effect.gen(function* () {
      const { servers, opened, session } = yield* slack(1)
      yield* servers[0]!.push({ type: "disconnect", reason: "link_disabled" })

      const exit = yield* Effect.exit(Queue.take(session.envelopes))
      expect(exit).toEqual(
        Exit.fail(
          new MessengerError.MessengerTransportClosed({
            provider: "slack",
            reason: "link_disabled",
          }),
        ),
      )
      expect(yield* opened).toBe(1)
    }).pipe(Effect.scoped),
  )
})
