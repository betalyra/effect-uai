/**
 * Protocol revision 2025-06-18: the handshake era, and the compatibility mode
 * this client keeps for the servers that have not migrated. Also serves
 * 2025-11-25, which is wire-compatible for a tools-only client (see
 * `2025-11-25.ts`).
 *
 * Three things differ from the stateless era, and they are all here:
 * an `initialize` exchange at connect, a negotiated version echoed on every
 * later request, and server-initiated requests arriving on the connection.
 *
 * The HTTP session id (`Mcp-Session-Id`) is deliberately *not* here: it is a
 * transport concern that `httpTransport` captures and echoes on its own, so
 * this file stays transport-agnostic.
 */
import { Effect, Option, type Scope } from "effect"
import { type McpError, McpUnsupportedProtocol } from "../../McpError.js"
import type { Protocol, ProtocolProbe } from "../protocol.js"
import type { Inbound, McpConnection, SendMeta } from "../rpc.js"
import {
  asProtocolVersion,
  CLIENT_INFO,
  CODE_METHOD_NOT_FOUND,
  decodeInitializeResult,
  LEGACY_VERSION,
  type McpMethod,
  type ProtocolVersion,
  type ServerInfo,
} from "../schema.js"

const UNKNOWN_SERVER: ServerInfo = { name: "unknown" }

/**
 * Legacy params travel bare: no `_meta` envelope. Only the negotiated version
 * rides along, and on HTTP only as a header.
 */
const makeProtocol = (
  connection: McpConnection,
  version: ProtocolVersion,
  serverInfo: ServerInfo,
): Protocol => ({
  version,
  serverInfo,
  envelope: (_method: McpMethod, params: unknown) => params ?? {},
  meta: (): SendMeta => ({ headers: { "MCP-Protocol-Version": version } }),
  onInbound: (inbound: Inbound) => answer(connection, inbound),
})

/**
 * Legacy servers may send requests to the client. We are a headless tools
 * client: answer `ping` so the connection stays healthy, and decline
 * everything else (sampling, elicitation, roots) with method-not-found rather
 * than leaving the server waiting.
 */
const answer = (connection: McpConnection, inbound: Inbound): Effect.Effect<void> =>
  Option.match(inbound.id, {
    // A notification expects no reply.
    onNone: () => Effect.void,
    onSome: (id) =>
      (inbound.method === "ping"
        ? connection.respond(id, {})
        : connection.respondError(
            id,
            CODE_METHOD_NOT_FOUND,
            `${inbound.method} is not supported by this client`,
          )
      ).pipe(Effect.ignore),
  })

/**
 * Run the `initialize` handshake. Unlike the stateless probe there is nothing
 * to fall back to afterwards, so a failure here propagates rather than
 * yielding `None`: this is the last era we speak.
 */
export const probe: ProtocolProbe = (connection: McpConnection) =>
  handshake(connection).pipe(Effect.map(Option.some))

const handshake = (connection: McpConnection): Effect.Effect<Protocol, McpError, Scope.Scope> =>
  Effect.gen(function* () {
    const raw = yield* connection.request("initialize", {
      protocolVersion: LEGACY_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    const result = yield* decodeInitializeResult(raw).pipe(
      Effect.mapError(
        () =>
          new McpUnsupportedProtocol({
            offered: [],
            reason: "initialize returned an undecodable result",
          }),
      ),
    )
    // The server picks the version; we either speak it or we stop here.
    const version = yield* Option.match(asProtocolVersion(result.protocolVersion), {
      onNone: () =>
        Effect.fail(
          new McpUnsupportedProtocol({
            offered: [result.protocolVersion],
            reason: `the server negotiated ${result.protocolVersion}, which this client does not support`,
          }),
        ),
      onSome: Effect.succeed,
    })

    // Required by the spec before any other request; failing to send it is
    // fatal to the session, so it is not ignored.
    yield* connection.notify("notifications/initialized")

    return makeProtocol(connection, version, result.serverInfo ?? UNKNOWN_SERVER)
  })
