/**
 * Streamable HTTP `Transport`. Each client message is its own POST; the server
 * answers with either one JSON object or a request-scoped SSE stream ending in
 * the JSON-RPC response, and a client MUST accept both. Frames from every
 * in-flight POST demux into one `messages` stream, which the rpc core
 * correlates by id.
 *
 * Interrupting a request aborts its POST, which is exactly the spec's
 * cancellation signal (closing the response stream).
 */
import { Cause, Effect, Option, Queue, Ref, type Scope, Stream } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import * as SSE from "@effect-uai/core/SSE"
import {
  McpAuthRequired,
  McpConnectFailed,
  type McpError,
  McpProtocolError,
  McpTransportClosed,
} from "../McpError.js"
import { type Auth, authHeaders } from "./auth.js"
import type { SendMeta, Transport } from "./rpc.js"

export type HttpConfig = {
  readonly url: string
  /** Static, non-auth headers applied to every request. */
  readonly headers?: Record<string, string>
  /** Omit for a public server. Resolved per request, so a rotating source works. */
  readonly auth?: Auth
}

/** RFC 9728: the `resource_metadata` pointer on a 401's `WWW-Authenticate`. */
const resourceMetadataUrl = (wwwAuthenticate: string): string | undefined =>
  /resource_metadata="([^"]+)"/.exec(wwwAuthenticate)?.[1]

const unauthorized = (response: HttpClientResponse.HttpClientResponse): McpError => {
  const header = response.headers["www-authenticate"]
  const pointer = header === undefined ? undefined : resourceMetadataUrl(header)
  return new McpAuthRequired({
    ...(pointer !== undefined ? { resourceMetadataUrl: pointer } : {}),
    ...(header !== undefined ? { wwwAuthenticate: header } : {}),
  })
}

/**
 * A non-2xx that is not a 401. The body still matters: a modern server answers
 * `400` for `-32022` / `-32021` / `-32020` and `404` for `-32601`, and era
 * detection reads those codes off the JSON-RPC body. So the body is forwarded
 * into `messages` whenever it parses as JSON, and only a bodyless failure
 * becomes a transport error.
 */
const isJsonRpcBody = (body: string): boolean => body.trimStart().startsWith("{")

export const make = (
  config: HttpConfig,
): Effect.Effect<Transport, McpError, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const inbox = yield* Queue.make<string, Cause.Done>()
    yield* Effect.addFinalizer(() => Queue.end(inbox))

    // The legacy era's `Mcp-Session-Id` is a transport concern, not a protocol
    // one: capture whatever the server mints and echo it from then on, so the
    // protocol implementations stay transport-agnostic. Stateless servers
    // never send one, and this stays empty.
    const session = yield* Ref.make(Option.none<string>())

    const post = (frame: string, meta?: SendMeta): Effect.Effect<void, McpError> =>
      Effect.gen(function* () {
        const sessionId = yield* Ref.get(session)
        const auth = yield* authHeaders(Option.fromNullishOr(config.auth))
        const request = HttpClientRequest.post(config.url).pipe(
          HttpClientRequest.setHeaders({
            "content-type": "application/json",
            // Both response shapes are legal for any request.
            accept: "application/json, text/event-stream",
            ...config.headers,
            ...auth,
            ...meta?.headers,
            ...Option.match(sessionId, {
              onNone: () => ({}),
              onSome: (id) => ({ "Mcp-Session-Id": id }),
            }),
          }),
          // The content type must be set on the body: it overrides any header.
          HttpClientRequest.bodyText(frame, "application/json"),
        )
        const response = yield* client
          .execute(request)
          .pipe(
            Effect.mapError(
              (cause) => new McpConnectFailed({ reason: "MCP request failed", raw: cause }),
            ),
          )
        yield* captureSession(response)
        yield* ingest(response)
      })

    const captureSession = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<void> => {
      const minted = response.headers["mcp-session-id"]
      return minted === undefined ? Effect.void : Ref.set(session, Option.some(minted))
    }

    const ingest = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<void, McpError> => {
      if (response.status === 401) return Effect.fail(unauthorized(response))
      // A 404 against a session we hold means the server dropped it; the
      // caller reconnects rather than retrying into a dead session.
      if (response.status === 404) {
        return Ref.get(session).pipe(
          Effect.flatMap((held) =>
            Option.isSome(held)
              ? Effect.fail(new McpTransportClosed({ reason: "the server expired this session" }))
              : readBody(response),
          ),
        )
      }
      // 202 answers a notification and carries no body.
      if (response.status === 202) return Effect.void

      const contentType = response.headers["content-type"] ?? ""
      if (contentType.includes("text/event-stream")) {
        return response.stream.pipe(
          SSE.fromBytes,
          Stream.runForEach((event) => Queue.offer(inbox, event.data)),
          Effect.mapError(
            (cause) => new McpTransportClosed({ reason: "SSE stream failed", raw: cause }),
          ),
        )
      }

      return readBody(response)
    }

    const readBody = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<void, McpError> =>
      response.text.pipe(
        Effect.mapError(
          (cause) => new McpTransportClosed({ reason: "could not read response", raw: cause }),
        ),
        Effect.flatMap((body) =>
          isJsonRpcBody(body)
            ? Effect.asVoid(Queue.offer(inbox, body))
            : Effect.fail(
                new McpProtocolError({
                  code: response.status,
                  reason: `HTTP ${response.status} with a non-JSON-RPC body`,
                  raw: body.slice(0, 500),
                }),
              ),
        ),
      )

    // The POST runs on the caller's fiber so interruption aborts it, which is
    // the spec's cancellation signal.
    return { send: post, messages: Stream.fromQueue(inbox) } satisfies Transport
  })
