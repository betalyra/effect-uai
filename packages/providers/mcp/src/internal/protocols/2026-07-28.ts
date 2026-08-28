/**
 * Protocol revision 2026-07-28: the stateless era. No handshake and no
 * session; every request self-describes via `_meta`, mirrored into the HTTP
 * request headers. Servers never send requests back, so `onInbound` has
 * nothing to answer.
 *
 * Files here are named for the revision they implement. A later revision that
 * keeps this wire shape gets its own file re-exporting this one.
 */
import { Effect, Option, Record, type Scope } from "effect"
import { type McpError, McpUnsupportedProtocol } from "../../McpError.js"
import { modernRejection, type Protocol, type ProtocolProbe } from "../protocol.js"
import type { McpConnection, SendMeta } from "../rpc.js"
import {
  asProtocolVersion,
  CLIENT_INFO,
  decodeDiscoverResult,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_SERVER_INFO,
  META_PROTOCOL_VERSION,
  type McpMethod,
  LATEST_VERSION,
  type ProtocolVersion,
  type ServerInfo,
} from "../schema.js"

const UNKNOWN_SERVER: ServerInfo = { name: "unknown" }

/** The methods whose subject name is mirrored into `Mcp-Name`. */
const NAME_FIELD = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
} as const satisfies Partial<Record<McpMethod | "prompts/get" | "resources/read", string>>

const subjectName = (method: McpMethod, params: unknown): Option.Option<string> =>
  Option.fromNullishOr(NAME_FIELD[method as keyof typeof NAME_FIELD]).pipe(
    Option.flatMap((field) =>
      Record.get(asRecord(params), field).pipe(
        Option.filter((value): value is string => typeof value === "string"),
      ),
    ),
  )

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

const SENTINEL = /^=\?base64\?.*\?=$/
// Visible ASCII only, no leading or trailing space (RFC 9110 field values).
const HEADER_SAFE = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/

/**
 * Header values outside the safe set (and any literal that would be mistaken
 * for the marker) ride the spec's Base64 sentinel form.
 */
export const headerValue = (raw: string): string => {
  if (HEADER_SAFE.test(raw) && !SENTINEL.test(raw)) return raw
  const bytes = new TextEncoder().encode(raw)
  return `=?base64?${btoa(String.fromCharCode(...bytes))}?=`
}

const makeProtocol = (version: ProtocolVersion, serverInfo: ServerInfo): Protocol => ({
  version,
  serverInfo,

  envelope: (_method, params) => ({
    ...asRecord(params),
    _meta: {
      [META_PROTOCOL_VERSION]: version,
      [META_CLIENT_INFO]: CLIENT_INFO,
      [META_CLIENT_CAPABILITIES]: {},
    },
  }),

  // `MCP-Protocol-Version` MUST equal the `_meta` version or the server
  // answers -32020, so both are minted from the same `version`.
  meta: (method, params): SendMeta => ({
    headers: {
      "MCP-Protocol-Version": version,
      "Mcp-Method": method,
      ...subjectName(method, params).pipe(
        Option.map((name) => ({ "Mcp-Name": headerValue(name) })),
        Option.getOrElse(() => ({})),
      ),
    },
  }),

  onInbound: () => Effect.void,
})

/**
 * Probe with `server/discover`. A `DiscoverResult` means modern. A modern
 * error code means modern-but-rejected: on `-32022` retry with a mutual
 * version. Anything else yields `None`, i.e. "try the legacy handshake".
 */
export const probe: ProtocolProbe = (connection) =>
  discover(connection, LATEST_VERSION).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Option.match(modernRejection(error), {
        // Not a modern error shape, so this is not a modern server.
        onNone: () => Effect.succeedNone,
        onSome: ({ supported }) => retryOnMutualVersion(connection, supported),
      }),
    ),
  )

const retryOnMutualVersion = (
  connection: McpConnection,
  offered: ReadonlyArray<string>,
): Effect.Effect<Option.Option<Protocol>, McpError, Scope.Scope> =>
  Option.match(Option.firstSomeOf(offered.map(asProtocolVersion)), {
    onNone: () =>
      Effect.fail(
        new McpUnsupportedProtocol({
          offered,
          reason: "the server is modern but shares no protocol version with this client",
        }),
      ),
    onSome: (version) => discover(connection, version).pipe(Effect.map(Option.some)),
  })

const discover = (
  connection: McpConnection,
  version: ProtocolVersion,
): Effect.Effect<Protocol, McpError, Scope.Scope> =>
  Effect.gen(function* () {
    const probing = makeProtocol(version, UNKNOWN_SERVER)
    const raw = yield* connection.request(
      "server/discover",
      probing.envelope("server/discover", {}),
      probing.meta("server/discover", {}),
    )
    const result = yield* decodeDiscoverResult(raw).pipe(
      Effect.mapError(
        () =>
          new McpUnsupportedProtocol({
            offered: [],
            reason: "server/discover returned an undecodable result",
          }),
      ),
    )
    // The server answered on `version`, so it supports it; prefer it, and only
    // fall to its list if it somehow disagrees.
    const agreed = result.supportedVersions.includes(version)
      ? version
      : Option.getOrElse(
          Option.firstSomeOf(result.supportedVersions.map(asProtocolVersion)),
          () => version,
        )
    const identity = result._meta?.[META_SERVER_INFO] ?? result.serverInfo ?? UNKNOWN_SERVER
    return makeProtocol(agreed, identity)
  })
