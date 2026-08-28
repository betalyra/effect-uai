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

    const dispatch = (raw: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const json = yield* JSONL.parseSafe(raw)
        if (json === undefined) return
        const message = yield* decodeInboundMessage(json).pipe(Effect.option)
        if (Option.isNone(message)) return
        const { error, id, method, params, result } = message.value
        if (method !== undefined) {
          return yield* onInbound({ id: Option.fromNullishOr(id), method, params })
        }
        // JSON-RPC carries a null (or absent) id for errors raised before the
        // request could be attributed: parse failures, a rejected content type.
        // Nothing can be correlated, so every in-flight request takes the
        // failure rather than waiting for a reply that will never arrive.
        if (id === undefined || id === null) {
          return yield* error === undefined
            ? Effect.void
            : failAllPending((method) => replyError(method, error))
        }
        const taken = yield* Ref.modify(pending, (m) => [HashMap.get(m, id), HashMap.remove(m, id)])
        if (Option.isNone(taken)) {
          // A result for an unknown id is a late or duplicate reply: ignore it.
          // An *error* for an unknown id is a server-level rejection under an
          // id we never issued (DeepWiki answers `"id":"server-error"`), so it
          // must reach the caller rather than leave it waiting.
          return yield* error === undefined
            ? Effect.void
            : failAllPending((method) => replyError(method, error))
        }
        yield* error === undefined
          ? Deferred.succeed(taken.value.deferred, result ?? {})
          : Deferred.fail(taken.value.deferred, replyError(taken.value.method, error))
      })

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
