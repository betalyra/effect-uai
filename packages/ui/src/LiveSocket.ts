/**
 * The server side of a live session: one WebSocket, upgraded from an HTTP
 * route, carrying `Frame`s both ways.
 *
 *   HttpRouter.add("GET", "/ws", LiveSocket.handle({ up: UpJson, handler }))
 *
 * `handler` is a plain stream transformer from what the client sends to what
 * it receives, so it is testable without a socket. When the client closes,
 * `up` ends and the handler is interrupted; when the handler's stream ends,
 * the socket closes.
 */
import { Cause, Effect, Queue, type Schema, Stream } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type * as Socket from "effect/socket/Socket"
import * as Frame from "./Frame.js"
import { duplex } from "./internal/socket.js"
import { type Envelope, EnvelopeJson } from "./RunEvent.js"

export type Handler<U, E, R> = (
  up: Stream.Stream<Frame.Frame<U>>,
) => Stream.Stream<Frame.Frame<Envelope>, E, R>

const encodeDown = Frame.encode(EnvelopeJson)

const logEnd = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.logDebug("[live] closed")
    : Effect.logError("[live] failed", { cause: Cause.pretty(cause) })

export type Options<U, I, E, R> = {
  /** The app's upstream messages; one that does not decode is dropped with a warning. */
  readonly up: Schema.Codec<U, I>
  readonly handler: Handler<U, E, R>
}

/**
 * Run `handler` over an open socket until either side closes. Failures are
 * logged, never returned: there is no one left to return them to.
 */
export const run = <U, I, E, R>(
  socket: Socket.Socket,
  options: Options<U, I, E, R>,
): Effect.Effect<void, never, R> => {
  const decodeUp = Frame.decode(options.up)
  // A frame that doesn't decode is dropped (a `Result` failure), not fatal.
  const decoded = (wire: Frame.Wire) =>
    decodeUp(wire).pipe(
      Effect.tapError((error) => Effect.logWarning("[live] dropped frame", { error })),
      Effect.result,
    )
  return Effect.gen(function* () {
    const up = yield* Queue.unbounded<Frame.Frame<U>, Cause.Done>()
    const down = options.handler(Stream.fromQueue(up)).pipe(Stream.mapEffect(encodeDown))
    yield* duplex(socket)(down).pipe(
      Stream.filterMapEffect(decoded),
      Stream.runForEach((frame) => Queue.offer(up, frame)),
      Effect.ensuring(Queue.end(up)),
    )
  }).pipe(Effect.onError(logEnd), Effect.ignore)
}

/** Upgrade the request to a WebSocket and `run` the session on it. */
export const handle = <U, I, E, R>(
  options: Options<U, I, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | R
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    yield* run(yield* request.upgrade, options)
    return HttpServerResponse.empty()
  }).pipe(
    Effect.catchTag("HttpServerError", (error) =>
      Effect.as(
        Effect.logWarning("[live] upgrade failed", { error }),
        HttpServerResponse.empty({ status: 400 }),
      ),
    ),
  )
