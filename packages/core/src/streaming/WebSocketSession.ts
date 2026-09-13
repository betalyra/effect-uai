/**
 * One JSON-over-WebSocket session: connect, read decoded frames off a queue,
 * write frames back.
 *
 * For duplex protocols where the caller drives the conversation frame by
 * frame. The stream-shaped adapters (realtime STT and TTS) still carry their
 * own copies of this.
 */
import { Cause, type Duration, Effect, Match, Option, Queue, Schema, type Scope } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
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

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** A rejected WS upgrade surfaces only as prose, so the status is read from it. */
const isAuthRejection = (text: string): boolean => /\b40[13]\b/.test(text)

export const toAiError =
  (provider: string) =>
  (error: Socket.SocketError): AiError.AiError =>
    Match.value(error.reason).pipe(
      Match.tag("SocketOpenError", (reason) =>
        Match.value(reason.kind).pipe(
          Match.when(
            "Timeout",
            (): AiError.AiError => new AiError.Timeout({ provider, raw: error }),
          ),
          Match.orElse((): AiError.AiError =>
            isAuthRejection(describeCause(reason.cause))
              ? new AiError.AuthFailed({ provider, subtype: "auth", raw: error })
              : new AiError.Unavailable({ provider, raw: error }),
          ),
        ),
      ),
      Match.orElse((): AiError.AiError => new AiError.Unavailable({ provider, raw: error })),
    )

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
      // Effect's Socket treats every close code as an error by default.
      closeCodeIsError: (code) => code !== 1000 && code !== 1001 && code !== 1005,
      ...(options.openTimeout !== undefined && { openTimeout: options.openTimeout }),
    })
    const frames = yield* Queue.bounded<A, AiError.AiError | Cause.Done>(options.capacity ?? 64)
    const write = yield* socket.writer

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

    yield* socket.runString(onFrame).pipe(
      Effect.mapError(asAiError),
      // `Queue.end` on a clean close so the consumer drains what is queued;
      // a failure must not arrive looking like the end of the conversation.
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasFails(cause) ? Queue.failCause(frames, cause) : Queue.end(frames),
        onSuccess: () => Queue.end(frames),
      }),
      Effect.forkScoped,
    )

    return { send: (frame: string) => write(frame).pipe(Effect.mapError(asAiError)), frames }
  })
