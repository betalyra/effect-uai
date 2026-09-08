import {
  type Cause,
  Deferred,
  Duration,
  Effect,
  Match,
  Option,
  Queue,
  Redacted,
  Ref,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as MessengerError from "@effect-uai/core/MessengerError"
import * as Events from "./events.js"
import { provider } from "./rest.js"

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const Payload = Schema.Struct({
  op: Schema.Number,
  d: Schema.optional(Schema.Unknown),
  s: Schema.optional(Schema.NullOr(Schema.Number)),
  t: Schema.optional(Schema.NullOr(Schema.String)),
})
type Payload = typeof Payload.Type

const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))

const Hello = Schema.Struct({ heartbeat_interval: Schema.Number })

export const Ready = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, username: Schema.String }),
  session_id: Schema.String,
  resume_gateway_url: Schema.String,
})
export type Ready = typeof Ready.Type

/** `GET /gateway/bot`, the only REST call the session needs. */
export const GatewayInfo = Schema.Struct({ url: Schema.String })

// Send: 1 heartbeat, 2 identify, 6 resume. Receive: 0 dispatch, 7 reconnect,
// 9 invalid session, 10 hello, 11 heartbeat ack.
const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const

// ---------------------------------------------------------------------------
// Close codes
// ---------------------------------------------------------------------------

/** What the session does once a connection is gone. */
export type CloseAction = "resume" | "reidentify" | "fatal"

// Fatal: nothing about reconnecting would change the answer.
const fatalReasons: Record<number, string> = {
  4004: "authentication failed: the bot token was rejected",
  4010: "invalid shard",
  4011: "sharding required",
  4012: "invalid API version",
  4013: "invalid intents",
  4014: "disallowed intents: enable the privileged intent in the developer portal",
}

// The session is gone but the token is fine: identify fresh.
const staleSessionCodes = [4007, 4009]

/**
 * Everything else, transport drops included, resumes: Discord only names the
 * codes that must not be retried, so an unknown code is a reconnect.
 */
export const classifyClose = (code: number): CloseAction =>
  Match.value(code).pipe(
    Match.when(
      (c) => c in fatalReasons,
      (): CloseAction => "fatal",
    ),
    Match.when(
      (c) => staleSessionCodes.includes(c),
      (): CloseAction => "reidentify",
    ),
    Match.orElse((): CloseAction => "resume"),
  )

/** Discord's own words for a fatal code, since its close frames carry no reason. */
export const closeReason = (code: number, reason?: string): string =>
  fatalReasons[code] ??
  (reason === undefined || reason === "" ? `gateway closed with ${code}` : reason)

// A close we send ourselves. Anything but 1000/1001 keeps the session alive on
// Discord's side, which is what makes the next connection resumable.
const RESUMABLE_CLOSE = 4000

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type Config = {
  readonly token: Redacted.Redacted
  readonly intents: number
  /** From `GET /gateway/bot`. Resumes go to `resume_gateway_url` instead. */
  readonly url: string
}

/** A decoded dispatch beside the payload it came from, which `raw` carries. */
export type Incoming = {
  readonly dispatch: Events.Dispatch
  readonly raw: unknown
}

export type Session = {
  readonly bot: Events.BotIdentity
  /**
   * Dispatches in arrival order, ended when the scope closes and failed with
   * `MessengerTransportClosed` on a fatal gateway close.
   */
  readonly dispatches: Queue.Queue<Incoming, MessengerError.MessengerError | Cause.Done>
}

type Resume = { readonly id: string; readonly url: string }

type Ended = { readonly action: CloseAction; readonly code: number; readonly reason: string }

const socketCode = (error: Socket.SocketError): number =>
  error.reason._tag === "SocketCloseError" ? error.reason.code : 1006

const socketReason = (error: Socket.SocketError): string =>
  error.reason._tag === "SocketCloseError"
    ? (error.reason.closeReason ?? error.reason.message)
    : error.reason.message

// Discord asks for a random 1-5 s pause before identifying on a fresh session.
const freshSessionDelay = Effect.sync(() => Duration.millis(1000 + Math.random() * 4000))

// Capped exponential, from a beat to a minute. Reset once a connection is live.
const backoff = (attempt: number): Duration.Duration =>
  Duration.millis(Math.min(60_000, 500 * 2 ** attempt))

const identity = { os: "effect-uai", browser: "effect-uai", device: "effect-uai" }

/**
 * One gateway session: connect, identify, heartbeat, resume, reconnect.
 *
 * Returns once `READY` has arrived, so a bad token or a disallowed intent is
 * a `MessengerConnectFailed` at layer build rather than a stream that dies a
 * moment later. From then on reconnects are silent and only a fatal close
 * ends `dispatches`.
 */
export const connect = (
  cfg: Config,
): Effect.Effect<Session, MessengerError.MessengerConnectFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const dispatches = yield* Queue.unbounded<
      Incoming,
      MessengerError.MessengerError | Cause.Done
    >()
    const ready = yield* Deferred.make<Events.BotIdentity, MessengerError.MessengerConnectFailed>()
    const resume = yield* Ref.make(Option.none<Resume>())
    const attempts = yield* Ref.make(0)

    // -- one connection ----------------------------------------------------

    const once = Effect.gen(function* () {
      const from = yield* Ref.get(resume)
      // A resumable session has its own host; a fresh one starts at the URL
      // `GET /gateway/bot` gave us.
      const host = Option.match(from, { onNone: () => cfg.url, onSome: (r: Resume) => r.url })
      const socket = yield* Socket.makeWebSocket(`${host}/?v=10&encoding=json`, {
        // Effect treats every close as an error by default; the standard clean
        // codes are not, and Discord's 4xxx ones are what drives `classifyClose`.
        closeCodeIsError: (code: number) => code !== 1000 && code !== 1001 && code !== 1005,
        // The gateway takes its token in the identify payload, not a header,
        // so every runtime's global `WebSocket` is enough.
      }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal))
      const write = yield* socket.writer
      const send = (payload: unknown) => write(JSON.stringify(payload))
      const seq = yield* Ref.make(Option.none<number>())
      const acked = yield* Ref.make(true)
      // Set by op 9 with `d: false`, the one case the close code cannot express.
      const requested = yield* Ref.make(Option.none<CloseAction>())

      const heartbeat = Effect.gen(function* () {
        const s = yield* Ref.get(seq)
        return yield* send({ op: OP.heartbeat, d: Option.getOrNull(s) })
      })

      // A beat with no ACK since the last one means the connection is a zombie:
      // close it non-cleanly so the next connection resumes.
      const beat = Effect.gen(function* () {
        const alive = yield* Ref.getAndSet(acked, false)
        if (!alive) {
          yield* write(new Socket.CloseEvent(RESUMABLE_CLOSE, "no heartbeat ack"))
          return false
        }
        yield* heartbeat
        return true
      })

      // Discord asks for the first beat to land at a random point in the
      // interval, so a fleet of bots does not beat in lockstep.
      const beating = (interval: number) =>
        Effect.sleep(Duration.millis(interval * Math.random())).pipe(
          Effect.andThen(
            beat.pipe(
              Effect.repeat({
                schedule: Schedule.spaced(Duration.millis(interval)),
                while: (alive: boolean) => alive,
              }),
            ),
          ),
          Effect.ignore,
          Effect.forkScoped,
        )

      const hello = (d: unknown) =>
        Effect.gen(function* () {
          const { heartbeat_interval } = yield* Schema.decodeUnknownEffect(Hello)(d)
          yield* beating(heartbeat_interval)
          const from = yield* Ref.get(resume)
          const s = yield* Ref.get(seq)
          return yield* Option.match(from, {
            onNone: () =>
              send({
                op: OP.identify,
                d: {
                  token: Redacted.value(cfg.token),
                  intents: cfg.intents,
                  properties: identity,
                },
              }),
            onSome: (r) =>
              send({
                op: OP.resume,
                d: {
                  token: Redacted.value(cfg.token),
                  session_id: r.id,
                  seq: Option.getOrNull(s),
                },
              }),
          })
        })

      const onReady = (d: unknown) =>
        Effect.gen(function* () {
          const info = yield* Schema.decodeUnknownEffect(Ready)(d)
          yield* Ref.set(resume, Option.some({ id: info.session_id, url: info.resume_gateway_url }))
          yield* Ref.set(attempts, 0)
          yield* Deferred.succeed(ready, info.user)
        })

      const onDispatch = (payload: Payload) =>
        Effect.gen(function* () {
          if (payload.s != null) yield* Ref.set(seq, Option.some(payload.s))
          if (payload.t === "READY") return yield* onReady(payload.d)
          if (payload.t === "RESUMED") return yield* Ref.set(attempts, 0)
          const dispatch = yield* Schema.decodeUnknownEffect(Events.Dispatch)({
            t: payload.t,
            d: payload.d,
          }).pipe(Effect.option)
          if (Option.isSome(dispatch)) {
            yield* Queue.offer(dispatches, { dispatch: dispatch.value, raw: payload.d })
          }
        })

      // `d: true` keeps the session, `d: false` drops it; both mean reconnect.
      const invalidSession = (d: unknown) =>
        Effect.gen(function* () {
          if (d !== true) {
            yield* Ref.set(resume, Option.none())
            yield* Ref.set(requested, Option.some<CloseAction>("reidentify"))
          }
          yield* write(new Socket.CloseEvent(RESUMABLE_CLOSE, "invalid session"))
        })

      const handle = (raw: string) =>
        Effect.gen(function* () {
          const payload = yield* decodeFrame(raw).pipe(Effect.option)
          if (Option.isNone(payload)) return
          const message = payload.value
          yield* Match.value(message.op).pipe(
            Match.when(OP.dispatch, () => onDispatch(message)),
            Match.when(OP.hello, () => hello(message.d)),
            Match.when(OP.heartbeatAck, () => Ref.set(acked, true)),
            Match.when(OP.heartbeat, () => heartbeat),
            Match.when(OP.reconnect, () =>
              write(new Socket.CloseEvent(RESUMABLE_CLOSE, "reconnect requested")),
            ),
            Match.when(OP.invalidSession, () => invalidSession(message.d)),
            Match.orElse(() => Effect.void),
          )
        }).pipe(Effect.ignore)

      // A clean 1000 is only ever our own teardown; anything else carries the
      // close code the classifier reads.
      const ended = yield* socket.runString(handle).pipe(
        Effect.as<Ended>({ action: "resume", code: 1000, reason: "closed" }),
        Effect.catch((error: Socket.SocketError) => {
          const code = socketCode(error)
          return Effect.succeed<Ended>({
            action: classifyClose(code),
            code,
            reason: closeReason(code, socketReason(error)),
          })
        }),
      )
      const override = yield* Ref.get(requested)
      return Option.match(override, {
        onNone: (): Ended => ended,
        onSome: (action): Ended => ({ ...ended, action }),
      })
    }).pipe(Effect.scoped)

    // -- the reconnect loop ------------------------------------------------

    const cycle = Effect.gen(function* () {
      const ended = yield* once
      if (ended.action === "fatal") {
        return yield* new MessengerError.MessengerTransportClosed({
          provider,
          reason: ended.reason,
          raw: { code: ended.code },
        })
      }
      const attempt = yield* Ref.get(attempts)
      yield* Ref.set(attempts, attempt + 1)
      const wait = ended.action === "reidentify" ? yield* freshSessionDelay : backoff(attempt)
      // Reconnects never reach `events`, so this is the only sign of one. A
      // dropped connection is noticed only when a heartbeat goes unacked,
      // which is up to two intervals after the network actually went away.
      yield* Effect.logDebug("gateway reconnecting", {
        code: ended.code,
        action: ended.action,
        attempt,
        in: Duration.toSeconds(wait),
      })
      yield* Effect.sleep(wait)
    })

    // Failing the deferred is a no-op once `READY` has landed, so the same
    // fatal close is a connect failure before it and a transport close after.
    yield* Effect.forever(cycle).pipe(
      Effect.catch((closed: MessengerError.MessengerTransportClosed) =>
        Deferred.fail(
          ready,
          new MessengerError.MessengerConnectFailed({
            provider,
            reason: closed.reason,
            raw: closed.raw,
          }),
        ).pipe(Effect.andThen(Queue.fail(dispatches, closed))),
      ),
      Effect.ensuring(Queue.end(dispatches)),
      Effect.forkScoped,
    )

    return { bot: yield* Deferred.await(ready), dispatches }
  })
