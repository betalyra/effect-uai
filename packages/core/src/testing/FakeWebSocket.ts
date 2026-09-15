/**
 * An in-memory WebSocket for testing socket adapters without a server.
 *
 * Provide `layer` in place of the real `Socket.WebSocketConstructor` and the
 * adapter runs end to end: its own connect, handshake, decode and teardown.
 * The test plays the other end with `reply`, `push`, `close` and `sent`.
 *
 * Client frames land on a queue, so the scripted server is a forked fiber and
 * `reply` is a real Effect. What stays imperative is the listener table the
 * shim registers, since `Socket.makeWebSocket` drives it with plain callbacks.
 * The shim is a plain object, so nothing here touches a platform global.
 */
import { Effect, Layer, Queue, Ref, type Scope, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

export type FakeWebSocketServer = {
  /** Every frame the client has sent, JSON-parsed, oldest first. */
  readonly sent: Effect.Effect<ReadonlyArray<unknown>>
  /** Deliver one frame to the client. */
  readonly push: (frame: unknown) => Effect.Effect<void>
  /** Close the socket. 1000, 1001 and 1005 are the clean codes. */
  readonly close: (code?: number) => Effect.Effect<void>
  /** Hand this to an adapter that takes a socket constructor directly. */
  readonly connect: Socket.WebSocketConstructor["Service"]
  /** Provide this in place of the real constructor. */
  readonly layer: Layer.Layer<Socket.WebSocketConstructor>
}

export type FakeWebSocketOptions = {
  /** Pushed once the client subscribes, for a protocol whose server speaks first. */
  readonly greeting?: ReadonlyArray<unknown>
  /** How the server answers each client frame. */
  readonly reply?: (frame: unknown) => Effect.Effect<ReadonlyArray<unknown>>
}

type Listener = (event: any) => void

const OPEN = 1
const CLOSED = 3

/** Run after the current call unwinds, so the client is never re-entered. */
const soon = (run: () => void): void => void Promise.resolve().then(run)

export const make = (
  options?: FakeWebSocketOptions,
): Effect.Effect<FakeWebSocketServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const inbound = yield* Queue.unbounded<unknown>()
    const sent = yield* Ref.make<ReadonlyArray<unknown>>([])

    const wiring = {
      listeners: {} as Record<string, ReadonlyArray<Listener>>,
      readyState: OPEN,
      greeted: false,
    }

    const emit = (type: string, event: unknown): void =>
      (wiring.listeners[type] ?? []).forEach((listener) => listener(event))

    const deliverSync = (frames: ReadonlyArray<unknown>): void =>
      frames.forEach((f) => emit("message", { data: JSON.stringify(f) }))

    const deliver = (frames: ReadonlyArray<unknown>): Effect.Effect<void> =>
      Effect.sync(() => deliverSync(frames))

    const shutdown = (code: number): void => {
      if (wiring.readyState === CLOSED) return
      wiring.readyState = CLOSED
      emit("close", { code, reason: "" })
    }

    // The scripted server. Answers land on their own turn, like a real one.
    yield* Stream.fromQueue(inbound).pipe(
      Stream.runForEach((frame) =>
        Effect.gen(function* () {
          yield* Ref.update(sent, (frames) => [...frames, frame])
          const answer = yield* options?.reply?.(frame) ?? Effect.succeed([])
          yield* deliver(answer)
        }),
      ),
      Effect.forkScoped,
    )

    const socket = {
      get readyState() {
        return wiring.readyState
      },
      addEventListener: (type: string, fn: Listener): void => {
        wiring.listeners = {
          ...wiring.listeners,
          [type]: [...(wiring.listeners[type] ?? []), fn],
        }
        // The greeting waits for a subscriber before it lands.
        if (type === "message" && !wiring.greeted) {
          wiring.greeted = true
          soon(() => deliverSync(options?.greeting ?? []))
        }
      },
      removeEventListener: (type: string, fn: Listener): void => {
        wiring.listeners = {
          ...wiring.listeners,
          [type]: (wiring.listeners[type] ?? []).filter((l) => l !== fn),
        }
      },
      // Safe from a synchronous callback, and no runtime needed.
      send: (data: string): void => void Queue.offerUnsafe(inbound, JSON.parse(data)),
      close: (code = 1000): void => shutdown(code),
    }

    const connect: Socket.WebSocketConstructor["Service"] = () =>
      socket as unknown as globalThis.WebSocket

    return {
      sent: Ref.get(sent),
      push: (frame) => deliver([frame]),
      close: (code = 1000) => Effect.sync(() => shutdown(code)),
      connect,
      layer: Layer.succeed(Socket.WebSocketConstructor, connect),
    }
  })
