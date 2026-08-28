/**
 * Era-blind JSON-RPC 2.0 correlation core over a `Transport` (cdp.ts model):
 * pending-`Deferred` map keyed by id, reader fiber that fails every pending
 * request on transport close. Era behavior layers on top in era.ts.
 */
import { Cause, Deferred, Effect, HashMap, Option, Ref, type Scope, Stream } from "effect"
import * as JSONL from "@effect-uai/core/JSONL"
import { type McpError, McpProtocolError, McpTransportClosed } from "../McpError.js"
import {
  decodeInboundMessage,
  type InboundMessage,
  type JsonRpcId,
  errorFrame,
  notificationFrame,
  requestFrame,
  resultFrame,
} from "./schema.js"

/** Per-request transport hints (era headers on HTTP; stdio ignores them). */
export type SendMeta = {
  readonly headers?: Record<string, string>
}

/** The transport seam: one framed JSON message per `send` / `messages` element. */
export type Transport = {
  readonly send: (frame: string, meta?: SendMeta) => Effect.Effect<void, McpError>
  readonly messages: Stream.Stream<string, McpError>
}

/** A server-initiated request (has `id`) or notification (no `id`). */
export type Inbound = {
  readonly id: Option.Option<JsonRpcId>
  readonly method: string
  readonly params: unknown
}

export type McpConnection = {
  readonly request: (
    method: string,
    params?: unknown,
    meta?: SendMeta,
  ) => Effect.Effect<unknown, McpError>
  readonly notify: (
    method: string,
    params?: unknown,
    meta?: SendMeta,
  ) => Effect.Effect<void, McpError>
  /** Answer a server-initiated request (legacy era only). */
  readonly respond: (id: JsonRpcId, result: unknown) => Effect.Effect<void, McpError>
  readonly respondError: (
    id: JsonRpcId,
    code: number,
    message: string,
  ) => Effect.Effect<void, McpError>
}

type Pending = {
  readonly method: string
  readonly deferred: Deferred.Deferred<unknown, McpError>
}

const replyError = (method: string, error: NonNullable<InboundMessage["error"]>): McpError =>
  new McpProtocolError({
    method,
    code: error.code,
    ...(error.message !== undefined ? { reason: error.message } : {}),
    raw: error,
  })

/**
 * Open a scoped connection over an already-open transport. `onInbound`
 * receives server-initiated frames; era.ts answers them via `transport.send`.
 */
export const open = (
  transport: Transport,
  onInbound: (inbound: Inbound) => Effect.Effect<void>,
): Effect.Effect<McpConnection, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pending = yield* Ref.make(HashMap.empty<JsonRpcId, Pending>())
    const counter = yield* Ref.make(0)
    const closeCause = yield* Ref.make<unknown>(undefined)

    // Fail every in-flight request with one error. Shared by transport close
    // and by unattributable server errors: a caller must never be left
    // awaiting a reply that cannot arrive.
    const failAllPending = (toError: (method: string) => McpError): Effect.Effect<void> =>
      Ref.getAndSet(pending, HashMap.empty()).pipe(
        Effect.flatMap((taken) =>
          Effect.forEach(HashMap.values(taken), ({ deferred, method }) =>
            Deferred.fail(deferred, toError(method)),
          ),
        ),
        Effect.asVoid,
      )

    // An error no pending request can claim: a null id (JSON-RPC raises one
    // before the request could be attributed) or an id we never issued. It
    // correlates to nothing, so everything in flight takes it rather than
    // waiting for a reply that cannot arrive. A *result* nobody claims is a
    // late or duplicate reply, and is simply dropped.
    const unattributable = (error: InboundMessage["error"]): Effect.Effect<void> =>
      error === undefined ? Effect.void : failAllPending((method) => replyError(method, error))

    const settle = ({ deferred, method }: Pending, message: InboundMessage): Effect.Effect<void> =>
      Effect.asVoid(
        message.error === undefined
          ? Deferred.succeed(deferred, message.result ?? {})
          : Deferred.fail(deferred, replyError(method, message.error)),
      )

    const reply = (id: JsonRpcId, message: InboundMessage): Effect.Effect<void> =>
      Ref.modify(pending, (m) => [HashMap.get(m, id), HashMap.remove(m, id)]).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => unattributable(message.error),
            onSome: (entry) => settle(entry, message),
          }),
        ),
      )

    // A frame carrying a `method` is server-initiated; anything else is a
    // reply, correlated by id.
    const route = (message: InboundMessage): Effect.Effect<void> =>
      Option.match(Option.fromNullishOr(message.method), {
        onNone: () =>
          Option.match(Option.fromNullishOr(message.id), {
            onNone: () => unattributable(message.error),
            onSome: (id) => reply(id, message),
          }),
        onSome: (method) =>
          onInbound({ id: Option.fromNullishOr(message.id), method, params: message.params }),
      })

    // Unparseable and undecodable frames are dropped: one bad frame must not
    // end an otherwise healthy connection.
    const dispatch = (raw: string): Effect.Effect<void> =>
      JSONL.parseSafe(raw).pipe(
        Effect.flatMap((json) => Effect.option(decodeInboundMessage(json))),
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: route })),
      )

    // Fail every still-pending request on transport close so callers never hang.
    const failPending = Effect.gen(function* () {
      const raw = yield* Ref.get(closeCause)
      yield* failAllPending(
        (method) => new McpTransportClosed({ method, reason: "connection closed", raw }),
      )
    })
    yield* transport.messages.pipe(
      Stream.runForEach(dispatch),
      Effect.tapCause((cause) => Ref.set(closeCause, Cause.squash(cause))),
      Effect.ensuring(failPending),
      Effect.forkScoped,
    )

    const request = (
      method: string,
      params?: unknown,
      meta?: SendMeta,
    ): Effect.Effect<unknown, McpError> =>
      Effect.gen(function* () {
        const id: JsonRpcId = yield* Ref.updateAndGet(counter, (n) => n + 1)
        const deferred = yield* Deferred.make<unknown, McpError>()
        yield* Ref.update(pending, (m) => HashMap.set(m, id, { method, deferred }))
        // `ensuring` reclaims the entry on send failure and interruption; on
        // success dispatch has already removed it.
        return yield* transport.send(requestFrame(id, method, params), meta).pipe(
          Effect.flatMap(() => Deferred.await(deferred)),
          Effect.ensuring(Ref.update(pending, (m) => HashMap.remove(m, id))),
        )
      })

    const notify = (
      method: string,
      params?: unknown,
      meta?: SendMeta,
    ): Effect.Effect<void, McpError> => transport.send(notificationFrame(method, params), meta)

    const respond = (id: JsonRpcId, result: unknown): Effect.Effect<void, McpError> =>
      transport.send(resultFrame(id, result))

    const respondError = (
      id: JsonRpcId,
      code: number,
      message: string,
    ): Effect.Effect<void, McpError> => transport.send(errorFrame(id, code, message))

    return { request, notify, respond, respondError }
  })
