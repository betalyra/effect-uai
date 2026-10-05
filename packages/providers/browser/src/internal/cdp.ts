/**
 * Minimal raw Chrome DevTools Protocol client over a WebSocket.
 *
 * CDP is JSON-RPC-shaped: commands are `{ id, method, params, sessionId? }`,
 * replies are `{ id, result }` or `{ id, error }`, and events are `{ method,
 * params }` with no id. Commands are correlated via a pending-`Deferred`
 * map; events are demuxed into a `PubSub` that callers subscribe to (e.g.
 * navigation waits on `Page.loadEventFired` instead of polling).
 *
 * Commands are typed against the official `devtools-protocol` schema (types
 * only, zero runtime): `send("Page.navigate", params)` gets its params and
 * return type from the protocol. The transport rides the runtime's global
 * `WebSocket`, so no `ws` dependency is needed; handshake headers (an auth
 * token) need a runtime whose `WebSocket` accepts them, i.e. Node or Bun.
 *
 * Failures are transport-shaped ({@link CdpError}), not the public
 * `BrowserError`: the transport cannot know which browser verb a command was
 * serving, so the session layer maps `CdpError` onto the typed `BrowserError`
 * using the operation it knows.
 */
import {
  Cause,
  Data,
  Deferred,
  Effect,
  HashMap,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import * as Socket from "effect/socket/Socket"
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js"
import * as JSONL from "@effect-uai/core/JSONL"
import * as WebSocketSession from "@effect-uai/core/WebSocketSession"

type Commands = ProtocolMapping.Commands

export type CdpMethod = keyof Commands
export type CdpParams<M extends CdpMethod> = Commands[M]["paramsType"][0]
export type CdpReturn<M extends CdpMethod> = Commands[M]["returnType"]

/**
 * Transport-level failure. `reply` is the browser rejecting a command,
 * `write` is a failed socket send, `closed` is the connection going away
 * (or never opening; the socket connects lazily) with the command still in
 * flight. `method` names the CDP command that was in flight.
 */
export class CdpError extends Data.TaggedError("CdpError")<{
  kind: "reply" | "write" | "closed"
  method?: string
  reason?: string
  raw?: unknown
}> {}

/** An id-less CDP message: an event emitted by the browser. */
export type CdpEvent = {
  readonly method: string
  readonly params: unknown
  readonly sessionId: string | undefined
}

export type Cdp = {
  readonly send: <M extends CdpMethod>(
    method: M,
    params?: CdpParams<M>,
    sessionId?: string,
  ) => Effect.Effect<CdpReturn<M>, CdpError>
  /**
   * Subscribe to browser events. Subscribe BEFORE issuing the command
   * whose event you await, or the event can slip past. Subscription
   * lifetime is the scope.
   */
  readonly subscribe: Effect.Effect<PubSub.Subscription<CdpEvent>, never, Scope.Scope>
}

// Replies are heterogeneous per command; the map is keyed by request id and the
// awaited value is narrowed back to `CdpReturn<M>` at the `send` boundary. The
// method rides along so a failure can name the command it was for.
type Pending = {
  readonly method: string
  readonly deferred: Deferred.Deferred<unknown, CdpError>
}

const CdpMessage = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  sessionId: Schema.optional(Schema.String),
})
const decodeMessage = Schema.decodeUnknownEffect(CdpMessage)

const frame = (
  id: number,
  method: string,
  params: unknown,
  sessionId: string | undefined,
): string =>
  JSON.stringify(
    sessionId === undefined ? { id, method, params } : { id, method, params, sessionId },
  )

/** Effect's global constructor rejects client options, so headers get their own. */
const constructorFor = (
  headers: Readonly<Record<string, string>> | undefined,
): Layer.Layer<Socket.WebSocketConstructor> =>
  headers === undefined
    ? Socket.layerWebSocketConstructorGlobal
    : Layer.succeed(Socket.WebSocketConstructor)(
        (url) => new globalThis.WebSocket(url, { headers } as unknown as string),
      )

/**
 * Open a scoped CDP connection to a browser-level WebSocket endpoint. The
 * socket and its reader fiber are torn down on scope close. A bad endpoint
 * surfaces on the first `send` as a `CdpError` of kind `closed` (carrying the
 * socket failure on `raw`), not here.
 */
export const openCdp = (
  endpoint: string,
  headers?: Readonly<Record<string, string>>,
): Effect.Effect<Cdp, never, Scope.Scope> =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(endpoint).pipe(
      Effect.provide(constructorFor(headers)),
    )

    const pending = yield* Ref.make(HashMap.empty<number, Pending>())
    const counter = yield* Ref.make(0)
    const events = yield* PubSub.unbounded<CdpEvent>()
    // Why the socket died (failed to open, dropped, dirty close); carried on
    // the `closed` errors handed to in-flight commands.
    const closeCause = yield* Ref.make<unknown>(undefined)
    // The writer waits for a reconnect rather than failing, so a command sent
    // after the reader ends is refused here.
    const ended = yield* Ref.make(false)
    const { write } = yield* socket.writer

    const dispatch = (raw: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const json = yield* JSONL.parseSafe(raw)
        if (json === undefined) return
        const message = yield* decodeMessage(json).pipe(Effect.option)
        if (Option.isNone(message)) return
        if (message.value.id === undefined) {
          if (message.value.method !== undefined) {
            yield* PubSub.publish(events, {
              method: message.value.method,
              params: message.value.params,
              sessionId: message.value.sessionId,
            })
          }
          return
        }
        const id = message.value.id
        const taken = yield* Ref.modify(pending, (m) => [HashMap.get(m, id), HashMap.remove(m, id)])
        if (Option.isNone(taken)) return
        yield* message.value.error === undefined
          ? Deferred.succeed(taken.value.deferred, message.value.result ?? {})
          : Deferred.fail(
              taken.value.deferred,
              new CdpError({
                kind: "reply",
                method: taken.value.method,
                reason: message.value.error.message ?? "CDP error",
                raw: message.value.error,
              }),
            )
      })

    // Reader fiber: fail every still-pending command when the socket closes so
    // callers don't hang.
    const failPending = Effect.gen(function* () {
      const raw = yield* Ref.get(closeCause)
      const taken = yield* Ref.getAndSet(pending, HashMap.empty())
      yield* Effect.forEach(HashMap.values(taken), ({ deferred, method }) =>
        Deferred.fail(
          deferred,
          new CdpError({ kind: "closed", method, reason: "connection closed", raw }),
        ),
      )
    })
    yield* Stream.fromPull(Socket.readerString(socket)).pipe(
      Stream.scoped,
      Stream.catchIf(WebSocketSession.isCleanClose, () => Stream.empty),
      Stream.runForEach(dispatch),
      Effect.tapCause((cause) => Ref.set(closeCause, Cause.squash(cause))),
      Effect.ensuring(Effect.andThen(Ref.set(ended, true), failPending)),
      Effect.forkScoped,
    )

    const closed = (method: string) =>
      Effect.flatMap(Ref.get(closeCause), (raw) =>
        Effect.fail(new CdpError({ kind: "closed", method, reason: "connection closed", raw })),
      )

    const send = <M extends CdpMethod>(
      method: M,
      params?: CdpParams<M>,
      sessionId?: string,
    ): Effect.Effect<CdpReturn<M>, CdpError> =>
      Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(counter, (n) => n + 1)
        const deferred = yield* Deferred.make<unknown, CdpError>()
        const entry: Pending = { method, deferred }
        yield* Ref.update(pending, HashMap.set(id, entry))
        // Checked after registering: either `failPending` sees this entry, or
        // this sees the flag it sets first.
        if (yield* Ref.get(ended)) {
          yield* Ref.update(pending, HashMap.remove(id))
          return yield* closed(method)
        }
        const written = write(frame(id, method, params ?? {}, sessionId)).pipe(
          Effect.mapError(
            (raw) => new CdpError({ kind: "write", method, reason: "socket write failed", raw }),
          ),
        )
        // Concurrent, because a write before the socket opens waits for it; a
        // socket that never opens fails the reply instead, which ends the write.
        // `ensuring` reclaims the entry on failure and on caller interruption.
        const [, result] = yield* Effect.all([written, Deferred.await(deferred)], {
          concurrency: 2,
        }).pipe(Effect.ensuring(Ref.update(pending, HashMap.remove(id))))
        return result as CdpReturn<M>
      })

    const cdp: Cdp = { send, subscribe: PubSub.subscribe(events) }
    return cdp
  })
