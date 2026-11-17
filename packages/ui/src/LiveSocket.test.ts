import { describe, it } from "@effect/vitest"
import { type Cause, Effect, Fiber, Option, Queue, Ref, Schema, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Socket from "effect/socket/Socket"
import { expect } from "vitest"
import * as Atoms from "./Atoms.js"
import * as Frame from "./Frame.js"
import { duplex } from "./internal/socket.js"
import * as LiveSocket from "./LiveSocket.js"
import * as Run from "./Run.js"
import { type RunEvent, StreamId } from "./RunEvent.js"
import * as StreamView from "./StreamView.js"
import * as Transport from "./Transport.js"

const Say = Schema.Struct({ text: Schema.String })
type Say = typeof Say.Type

const closed = new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) })

// Two in-memory sockets wired to each other. Writing a close, or releasing
// the reader's scope, ends both directions, as a WebSocket close does.
const pair = Effect.gen(function* () {
  const aToB = yield* Queue.unbounded<Frame.Wire, Cause.Done>()
  const bToA = yield* Queue.unbounded<Frame.Wire, Cause.Done>()
  const shut = yield* Ref.make(false)
  const side = (inbox: typeof aToB, outbox: typeof aToB) => {
    const close = Ref.set(shut, true).pipe(
      Effect.andThen(Queue.end(outbox)),
      Effect.andThen(Queue.end(inbox)),
    )
    // Like Effect's WebSocket: once closed, a write waits for a reconnect that never comes.
    const write = (chunk: Frame.Wire | Socket.CloseEvent): Effect.Effect<void> =>
      Effect.flatMap(Ref.get(shut), (ended) => {
        if (ended) return Effect.never
        return Socket.isCloseEvent(chunk) ? close : Effect.asVoid(Queue.offer(outbox, chunk))
      })
    return Socket.make({
      reader: Effect.acquireRelease(
        Effect.succeed({
          pull: Queue.take(inbox).pipe(
            Effect.map((wire) => [wire] as const),
            Effect.mapError(() => closed),
          ),
          upgrade: () => Effect.void,
        }),
        () => close,
      ),
      writer: Effect.succeed({
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
      }),
    })
  }
  return { server: side(bToA, aToB), client: side(aToB, bToA) } as const
})

// Each line said becomes a `data` entry; mic media on channel 0 comes back on channel 1.
const echo: LiveSocket.Handler<Say, never, never> = (up) =>
  up.pipe(
    Stream.map(
      Frame.Frame.$match({
        Message: ({ message }): Frame.Frame<Run.Owned> =>
          Frame.message({
            event: { type: "data", name: "line", id: message.text, value: message },
          }),
        Media: ({ bytes }) => Frame.media(1, bytes),
      }),
    ),
    Stream.prepend([
      Frame.message<Run.Owned>({
        event: {
          type: "channel-opened",
          channel: 1,
          direction: "down",
          mimeType: "audio/pcm",
          sampleRate: 48000,
        },
      }),
    ]),
    Frame.sequence(StreamId.make("live")),
  )

const runtime = Atom.runtime(SecureRandom.layerWebCrypto)

const session = (
  handler: LiveSocket.Handler<Say, never, never>,
  media: (frame: Frame.Media) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const sockets = yield* pair
    const server = yield* LiveSocket.run(sockets.server, { up: Say, handler }).pipe(
      Effect.forkChild,
    )
    const live = Atoms.live({
      runtime,
      transport: Transport.live({ connect: (up) => duplex(sockets.client)(up), up: Say }),
      initial: StreamView.initial,
      step: StreamView.step,
      media,
      ended: (view) => ({ ...view, live: { ...view.live, ended: true } }),
    })
    return { server, live } as const
  })

describe("LiveSocket over Transport.live", () => {
  it.effect("messages and media cross both ways; disconnect ends the server's session", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<Frame.Media>>([])
      const { server, live } = yield* session(echo, (frame) =>
        Ref.update(received, (all) => [...all, frame]),
      )
      const registry = AtomRegistry.make()
      registry.set(live.connect, undefined)
      registry.set(live.send, Frame.message({ text: "hello" }))
      registry.set(live.send, Frame.media(0, new Uint8Array([1, 2])))

      const view = yield* AtomRegistry.toStream(registry, live.state).pipe(
        Stream.filter((v) => v.data.line?.hello !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )
      expect(view.channels["1"]?.sampleRate).toBe(48000)
      expect(registry.get(live.connected)).toBe(true)
      yield* Ref.get(received).pipe(
        Effect.tap(() => Effect.yieldNow),
        Effect.repeat({ until: (all) => all.length === 1 }),
        Effect.map((all) => expect(all).toEqual([Frame.media(1, new Uint8Array([1, 2]))])),
      )

      registry.set(live.disconnect, undefined)
      yield* Fiber.join(server)
      expect(registry.get(live.connected)).toBe(false)
      // Disconnecting is not an end the app has to be told about.
      expect(registry.get(live.state).live.ended).toBeUndefined()
    }),
  )

  it.effect("a handler that finishes closes the session on the client", () =>
    Effect.gen(function* () {
      const done: RunEvent = { type: "live", name: "bye", value: true }
      const { live } = yield* session(
        () => Stream.make(Frame.message({ event: done })).pipe(Frame.sequence(StreamId.make("s"))),
        () => Effect.void,
      )
      const registry = AtomRegistry.make()
      registry.set(live.connect, undefined)
      const view = yield* AtomRegistry.toStream(registry, live.state).pipe(
        Stream.filter((v) => v.live.ended === true),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )
      expect(view.live.bye).toBe(true)
    }),
  )
})
