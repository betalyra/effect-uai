import { Cause, Effect, Exit, Fiber, Option, Queue, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { McpProtocolError, McpTransportClosed } from "../McpError.js"
import { type Inbound, open, type SendMeta, type Transport } from "./rpc.js"

type Sent = { readonly frame: string; readonly meta: SendMeta | undefined }

// In-memory Transport stub: a scripted `messages` queue + a recording `send`.
const makeStub = Effect.gen(function* () {
  const queue = yield* Queue.make<string, Cause.Done>()
  const sent: Array<Sent> = []
  const transport: Transport = {
    send: (frame, meta) => Effect.sync(() => void sent.push({ frame, meta })),
    messages: Stream.fromQueue(queue),
  }
  return {
    transport,
    sent,
    push: (message: unknown) => Queue.offer(queue, JSON.stringify(message)),
    pushRaw: (frame: string) => Queue.offer(queue, frame),
    close: Queue.end(queue),
  }
})

const until = (pred: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() => (pred() ? Effect.void : Effect.flatMap(Effect.yieldNow, () => until(pred))))

const noInbound = (): Effect.Effect<void> => Effect.void

describe("rpc correlation core", () => {
  it("correlates out-of-order replies by id", async () => {
    const program = Effect.gen(function* () {
      const stub = yield* makeStub
      const connection = yield* open(stub.transport, noInbound)
      const first = yield* Effect.fork(connection.request("tools/list"))
      const second = yield* Effect.fork(connection.request("tools/call", { name: "a" }))
      yield* until(() => stub.sent.length === 2)
      yield* stub.push({ jsonrpc: "2.0", id: 2, result: { fromSecond: true } })
      yield* stub.push({ jsonrpc: "2.0", id: 1, result: { fromFirst: true } })
      const secondResult = yield* Fiber.join(second)
      const firstResult = yield* Fiber.join(first)
      return { firstResult, secondResult, frames: stub.sent.map((s) => JSON.parse(s.frame)) }
    })
    const { firstResult, frames, secondResult } = await Effect.runPromise(Effect.scoped(program))
    expect(firstResult).toEqual({ fromFirst: true })
    expect(secondResult).toEqual({ fromSecond: true })
    expect(frames[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    expect(frames[1].params).toEqual({ name: "a" })
  })

  it("maps a JSON-RPC error reply to McpProtocolError with its code", async () => {
    const program = Effect.gen(function* () {
      const stub = yield* makeStub
      const connection = yield* open(stub.transport, noInbound)
      const fiber = yield* Effect.fork(Effect.exit(connection.request("tools/call")))
      yield* until(() => stub.sent.length === 1)
      yield* stub.push({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } })
      return yield* Fiber.join(fiber)
    })
    const exit = await Effect.runPromise(Effect.scoped(program))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(McpProtocolError)
    expect((error as McpProtocolError).code).toBe(-32602)
    expect((error as McpProtocolError).method).toBe("tools/call")
    expect((error as McpProtocolError).reason).toBe("bad params")
  })

  it("fails every pending request when the transport closes", async () => {
    const program = Effect.gen(function* () {
      const stub = yield* makeStub
      const connection = yield* open(stub.transport, noInbound)
      const first = yield* Effect.fork(Effect.exit(connection.request("tools/list")))
      const second = yield* Effect.fork(Effect.exit(connection.request("tools/call")))
      yield* until(() => stub.sent.length === 2)
      yield* stub.close
      return [yield* Fiber.join(first), yield* Fiber.join(second)]
    })
    const exits = await Effect.runPromise(Effect.scoped(program))
    for (const exit of exits) {
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(McpTransportClosed)
    }
  })

  it("routes server-initiated requests and notifications to onInbound", async () => {
    const program = Effect.gen(function* () {
      const stub = yield* makeStub
      const inbound: Array<Inbound> = []
      yield* open(stub.transport, (message) => Effect.sync(() => void inbound.push(message)))
      yield* stub.push({ jsonrpc: "2.0", id: 9, method: "ping" })
      yield* stub.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      yield* until(() => inbound.length === 2)
      return inbound
    })
    const inbound = await Effect.runPromise(Effect.scoped(program))
    expect(inbound[0].method).toBe("ping")
    expect(inbound[0].id).toEqual(Option.some(9))
    expect(inbound[1].method).toBe("notifications/tools/list_changed")
    expect(Option.isNone(inbound[1].id)).toBe(true)
  })

  it("notify sends an id-less frame", async () => {
    const program = Effect.gen(function* () {
      const stub = yield* makeStub
      const connection = yield* open(stub.transport, noInbound)
      yield* connection.notify("notifications/initialized")
      return stub.sent.map((s) => JSON.parse(s.frame))
    })
    const frames = await Effect.runPromise(Effect.scoped(program))
    expect(frames[0]).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" })
    expect("id" in frames[0]).toBe(false)
  })

  it("ignores replies for unknown ids and non-JSON frames", async () => {
    const program = Effect.gen(function* () {
      const stub = yield* makeStub
      const connection = yield* open(stub.transport, noInbound)
      yield* stub.push({ jsonrpc: "2.0", id: 99, result: {} })
      yield* stub.pushRaw("this is not json")
      const fiber = yield* Effect.fork(connection.request("tools/list"))
      yield* until(() => stub.sent.length === 1)
      yield* stub.push({ jsonrpc: "2.0", id: 1, result: { ok: true } })
      return yield* Fiber.join(fiber)
    })
    const result = await Effect.runPromise(Effect.scoped(program))
    expect(result).toEqual({ ok: true })
  })
})
