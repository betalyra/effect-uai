import {
  Array as Arr,
  type Cause,
  Deferred,
  Duration,
  Effect,
  Match,
  Option,
  Queue,
  Ref,
  Schema,
  type Scope,
} from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as MessengerError from "@effect-uai/core/MessengerError"
import * as Events from "./events.js"
import { provider } from "./api.js"

// ---------------------------------------------------------------------------
// Disconnects
// ---------------------------------------------------------------------------

/** What the session does once a connection is gone. */
export type DisconnectAction = "refresh" | "reconnect" | "fatal"

/**
 * Slack names the one reason that must not be retried; the rolling refresh is
 * scheduled rather than a failure, so it reconnects without backing off, and
 * an unknown reason is an ordinary reconnect.
 */
export const classifyDisconnect = (reason: string | undefined): DisconnectAction =>
  Match.value(reason).pipe(
    Match.when("link_disabled", (): DisconnectAction => "fatal"),
    Match.when("refresh_requested", (): DisconnectAction => "refresh"),
    Match.when("warning", (): DisconnectAction => "refresh"),
    Match.orElse((): DisconnectAction => "reconnect"),
  )

// ---------------------------------------------------------------------------
// Redelivery
// ---------------------------------------------------------------------------

/**
 * Transport state, not conversation state: Slack redelivers an envelope whose
 * acknowledgement it missed, and this exists only to drop the second copy.
 */
export type Recent = ReadonlyArray<string>

/** How many ids to hold. Redeliveries arrive at once, +1 minute and +5 minutes. */
export const RECENT = 256

/** `None` when `id` has been seen; otherwise the set with `id` in it, oldest dropped. */
export const remember = (seen: Recent, id: string, cap: number = RECENT): Option.Option<Recent> =>
  seen.includes(id) ? Option.none() : Option.some(Arr.takeRight([...seen, id], cap))

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type Config = {
  /**
   * A fresh single-use Socket Mode URL, called for every connection. Failing
   * before `hello` has ever arrived is what makes a bad app token a connect
   * failure rather than a silent retry.
   */
  readonly open: Effect.Effect<string, MessengerError.MessengerError>
}

/** A decoded envelope beside the frame it came from, which `raw` carries. */
export type Incoming = {
  readonly envelope: Events.Envelope
  readonly raw: unknown
}

export type Session = {
  /**
   * Envelopes in arrival order, already acknowledged, ended when the scope
   * closes and failed with `MessengerTransportClosed` on a disconnect Slack
   * says not to retry.
   */
  readonly envelopes: Queue.Queue<Incoming, MessengerError.MessengerError | Cause.Done>
}

type Ended = { readonly action: DisconnectAction; readonly reason: string }

const parseFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodeFrame = Schema.decodeUnknownEffect(Events.Frame)

const socketReason = (error: Socket.SocketError): string =>
  error.reason._tag === "SocketCloseError"
    ? (error.reason.closeReason ?? error.reason.message)
    : error.reason.message

const reasonOf = (e: MessengerError.MessengerError | Socket.SocketError): string =>
  e._tag === "SocketError" ? socketReason(e) : MessengerError.describe(e)

// Capped exponential, from a beat to a minute. Reset once a connection is live.
const backoff = (attempt: number): Duration.Duration =>
  Duration.millis(Math.min(60_000, 500 * 2 ** attempt))

/**
 * One Socket Mode session: open, acknowledge, dedupe, reconnect.
 *
 * Returns once `hello` has arrived, so a rejected app token is a
 * `MessengerConnectFailed` at layer build rather than a stream that dies a
 * moment later. From then on reconnects are silent and only a `link_disabled`
 * disconnect ends `envelopes`.
 */
export const connect = (
  cfg: Config,
): Effect.Effect<Session, MessengerError.MessengerConnectFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const envelopes = yield* Queue.unbounded<Incoming, MessengerError.MessengerError | Cause.Done>()
    const ready = yield* Deferred.make<void, MessengerError.MessengerConnectFailed>()
    const attempts = yield* Ref.make(0)
    const seen = yield* Ref.make<Recent>([])

    // -- one connection ----------------------------------------------------

    const once = Effect.gen(function* () {
      const url = yield* cfg.open
      const socket = yield* Socket.makeWebSocket(url, {
        // Effect treats every close as an error by default; the standard clean
        // codes are not, and Slack's close codes say nothing a reconnect
        // cannot fix, so a `disconnect` frame is the only fatal signal.
        closeCodeIsError: (code: number) => code !== 1000 && code !== 1001 && code !== 1005,
        // The ticket is in the URL, so every runtime's global `WebSocket` is enough.
      }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal))
      const write = yield* socket.writer
      // Set by a `disconnect` frame, the one end a close code cannot express.
      const requested = yield* Ref.make(Option.none<Ended>())

      // Acknowledged before the envelope is offered, well inside Slack's three
      // second deadline, so the platform is never waiting on the recipe.
      const acknowledge = (envelopeId: string) => write(JSON.stringify({ envelope_id: envelopeId }))

      // A redelivery is acknowledged like any other envelope and then dropped,
      // so Slack stops retrying it and the recipe never sees it twice.
      const offer = (envelope: Events.Envelope, raw: unknown) =>
        Effect.gen(function* () {
          yield* acknowledge(envelope.envelope_id)
          const id = Events.eventId(envelope)
          if (Option.isSome(id)) {
            const next = remember(yield* Ref.get(seen), id.value)
            if (Option.isNone(next)) return
            yield* Ref.set(seen, next.value)
          }
          yield* Queue.offer(envelopes, { envelope, raw })
        })

      const disconnect = (reason: string | undefined) =>
        Effect.gen(function* () {
          const action = classifyDisconnect(reason)
          yield* Ref.set(requested, Option.some<Ended>({ action, reason: reason ?? "disconnect" }))
          yield* write(new Socket.CloseEvent(1000, reason ?? "disconnect"))
        })

      const handle = (text: string) =>
        Effect.gen(function* () {
          const raw = yield* parseFrame(text).pipe(Effect.option)
          if (Option.isNone(raw)) return
          const frame = yield* decodeFrame(raw.value).pipe(Effect.option)
          if (Option.isNone(frame)) return
          yield* Match.value(frame.value).pipe(
            Match.when({ type: "hello" }, () =>
              Ref.set(attempts, 0).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
            ),
            Match.when({ type: "disconnect" }, ({ reason }) => disconnect(reason)),
            Match.orElse((envelope) => offer(envelope, raw.value)),
          )
        }).pipe(Effect.ignore)

      // A clean 1000 is only ever our own teardown or a disconnect we asked
      // for; anything else is a drop, and every drop reconnects.
      const ended = yield* socket.runString(handle).pipe(
        Effect.as<Ended>({ action: "reconnect", reason: "closed" }),
        Effect.catch((error: Socket.SocketError) =>
          Effect.succeed<Ended>({ action: "reconnect", reason: reasonOf(error) }),
        ),
      )
      return Option.getOrElse(yield* Ref.get(requested), () => ended)
    }).pipe(
      Effect.scoped,
      // A URL we cannot get, or a socket that will not open, is fatal only
      // before `hello`: a rejected app token fails the layer, while the same
      // failure later is one more reconnect.
      Effect.catch((e: MessengerError.MessengerError | Socket.SocketError) =>
        Effect.map(Deferred.isDone(ready), (live): Ended => ({
          action: live ? "reconnect" : "fatal",
          reason: reasonOf(e),
        })),
      ),
    )

    // -- the reconnect loop ------------------------------------------------

    const cycle = Effect.gen(function* () {
      const ended = yield* once
      if (ended.action === "fatal") {
        return yield* new MessengerError.MessengerTransportClosed({
          provider,
          reason: ended.reason,
        })
      }
      const attempt = yield* Ref.get(attempts)
      yield* Ref.set(attempts, attempt + 1)
      // A refresh is Slack cycling the connection on schedule, so the next one
      // opens at once; anything else backs off.
      const wait = ended.action === "refresh" ? Duration.zero : backoff(attempt)
      yield* Effect.logDebug("socket mode reconnecting", {
        reason: ended.reason,
        action: ended.action,
        attempt,
        in: Duration.toSeconds(wait),
      })
      yield* Effect.sleep(wait)
    })

    // Failing the deferred is a no-op once `hello` has landed, so the same end
    // is a connect failure before it and a transport close after.
    yield* Effect.forever(cycle).pipe(
      Effect.catch((closed: MessengerError.MessengerTransportClosed) =>
        Deferred.fail(
          ready,
          new MessengerError.MessengerConnectFailed({
            provider,
            reason: closed.reason,
            raw: closed.raw,
          }),
        ).pipe(Effect.andThen(Queue.fail(envelopes, closed))),
      ),
      Effect.ensuring(Queue.end(envelopes)),
      Effect.forkScoped,
    )

    yield* Deferred.await(ready)
    return { envelopes }
  })
