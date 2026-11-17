import { isCleanClose } from "@effect-uai/core/WebSocketSession"
import { Effect, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import type { Wire } from "../Frame.js"

/**
 * Both directions of one socket. Emits what arrives, until the peer closes
 * (a clean close ends the stream); meanwhile writes `outgoing`, then closes
 * with 1000 (1011 if `outgoing` fails). A WebSocket close ends both
 * directions, so the peer closing interrupts `outgoing`; an interrupted
 * session is closed by the socket's own scope.
 *
 * Never write from a finalizer: once the reader has closed, Effect's
 * WebSocket `write` waits for a reconnect that never comes, and an
 * uninterruptible wait there hangs shutdown.
 */
export const duplex =
  (socket: Socket.Socket) =>
  <E, R>(outgoing: Stream.Stream<Wire, E, R>): Stream.Stream<Wire, E | Socket.SocketError, R> => {
    const incoming = Stream.fromPull(Effect.map(socket.reader, (reader) => reader.pull)).pipe(
      Stream.scoped,
      Stream.catchIf(isCleanClose, () => Stream.empty),
    )
    const writing = Effect.gen(function* () {
      const { write } = yield* socket.writer
      yield* outgoing.pipe(
        Stream.runForEach(write),
        Effect.tapError(() => Effect.ignore(write(new Socket.CloseEvent(1011)))),
      )
      yield* write(new Socket.CloseEvent(1000))
    }).pipe(Effect.scoped)
    return incoming.pipe(Stream.drainFork(Stream.fromEffectDrain(writing)))
  }
