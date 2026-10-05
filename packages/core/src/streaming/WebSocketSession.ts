/**
 * One JSON-over-WebSocket session: connect, read decoded frames off a queue,
 * write frames back.
 *
 * For duplex protocols where the caller drives the conversation frame by
 * frame. The stream-shaped adapters (realtime STT and TTS) still carry their
 * own copies of this.
 */
import {
  Cause,
  type Duration,
  Effect,
  Match,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import * as Socket from "effect/socket/Socket"
import * as AiError from "../domain/AiError.js"
import * as JSONL from "./JSONL.js"

export type WebSocketSession<A> = {
  /** Fails `Unavailable` once the socket is closed. */
  readonly send: (frame: string) => Effect.Effect<void, AiError.AiError>
  /** Ends when the socket closes cleanly, fails when it does not. */
  readonly frames: Queue.Dequeue<A, AiError.AiError | Cause.Done>
}

export type OpenOptions<A, I> = {
  readonly url: string
  readonly provider: string
  /** Frames that do not decode are dropped, and logged at debug level. */
  readonly schema: Schema.Codec<A, I>
  readonly openTimeout?: Duration.Input
  readonly capacity?: number
}

/**
 * The cause of a failed open is a DOM `ErrorEvent`, not an `Error`, and its
 * `message` is a prototype getter, so a structural decode does not see it.
 */
const describeCause = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : String(cause)

/**
 * Some wires authenticate with a key in the query string, and some runtimes
 * name the socket URL in their open error (Bun does). Everything taken off a
 * socket error goes through this.
 */
export const redactUrl = (text: string): string =>
  text.replace(/(\b(?:wss?|https?):\/\/[^\s"']*?)\?[^\s"']*/gi, "$1?<redacted>")

const detailOf = Match.type<Socket.SocketError["reason"]>().pipe(
  Match.tag("SocketCloseError", (reason) => reason.message),
  Match.orElse((reason) => describeCause(reason.cause)),
)

/** Never the `SocketError` itself: callers print `raw` with `Cause.pretty`. */
const rawOf = (error: Socket.SocketError): string =>
  redactUrl(`${error.reason._tag}: ${detailOf(error.reason)}`)

/** A rejected WS upgrade surfaces only as prose, so the status is read from it. */
const isAuthRejection = (text: string): boolean => /\b40[13]\b/.test(text)

export const toAiError =
  (provider: string) =>
  (error: Socket.SocketError): AiError.AiError => {
    const raw = rawOf(error)
    return Match.value(error.reason).pipe(
      Match.tag("SocketOpenError", (reason) =>
        Match.value(reason.kind).pipe(
          Match.when("Timeout", (): AiError.AiError => new AiError.Timeout({ provider, raw })),
          Match.orElse((): AiError.AiError =>
            isAuthRejection(describeCause(reason.cause))
              ? new AiError.AuthFailed({ provider, subtype: "auth", raw })
              : new AiError.Unavailable({ provider, raw }),
          ),
        ),
      ),
      Match.orElse((): AiError.AiError => new AiError.Unavailable({ provider, raw })),
    )
  }

/** Normal closure, going away, and no status code. */
const cleanCloseCodes: ReadonlySet<number> = new Set([1000, 1001, 1005])

/** Effect's `Socket` fails on every close, clean or not. */
export const isCleanClose = (error: Socket.SocketError): boolean =>
  error.reason._tag === "SocketCloseError" && cleanCloseCodes.has(error.reason.code)

/**
 * Connect for the lifetime of the surrounding `Scope`. The reader runs in a
 * forked fiber; a dirty close reaches the consumer as a failed queue rather
 * than a clean end.
 */
export const open = <A, I>(
  options: OpenOptions<A, I>,
): Effect.Effect<WebSocketSession<A>, AiError.AiError, Scope.Scope | Socket.WebSocketConstructor> =>
  Effect.gen(function* () {
    const asAiError = toAiError(options.provider)
    const decode = Schema.decodeUnknownEffect(options.schema)
    const socket = yield* Socket.makeWebSocket(options.url, {
      ...(options.openTimeout !== undefined && { openTimeout: options.openTimeout }),
    })
    const frames = yield* Queue.bounded<A, AiError.AiError | Cause.Done>(options.capacity ?? 64)
    const { write } = yield* socket.writer
    // The writer waits for the next connection rather than failing, so a send
    // after the reader ends has to be refused here.
    const ended = yield* Ref.make(false)
    const closed = new AiError.Unavailable({ provider: options.provider, raw: "socket closed" })

    const onFrame = (raw: string) =>
      Effect.gen(function* () {
        const json = yield* JSONL.parseSafe(raw)
        if (json === undefined) return
        const decoded = yield* decode(json).pipe(Effect.option)
        if (Option.isNone(decoded)) {
          yield* Effect.logDebug(`[${options.provider}] dropped frame`, { frame: json })
          return
        }
        yield* Queue.offer(frames, decoded.value)
      })

    yield* Stream.fromPull(Socket.readerString(socket)).pipe(
      Stream.scoped,
      Stream.catchIf(isCleanClose, () => Stream.empty),
      Stream.runForEach(onFrame),
      Effect.mapError(asAiError),
      // Set before `frames` ends, so a send after the last frame already fails.
      Effect.ensuring(Ref.set(ended, true)),
      // `Queue.end` on a clean close so the consumer drains what is queued;
      // a failure must not arrive looking like the end of the conversation.
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasFails(cause) ? Queue.failCause(frames, cause) : Queue.end(frames),
        onSuccess: () => Queue.end(frames),
      }),
      Effect.forkScoped,
    )

    const send = (frame: string): Effect.Effect<void, AiError.AiError> =>
      Effect.flatMap(Ref.get(ended), (isEnded) =>
        isEnded ? Effect.fail(closed) : Effect.mapError(write(frame), asAiError),
      )

    return { send, frames }
  })
