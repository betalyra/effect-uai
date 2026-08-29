/**
 * Protocol revision 2026-07-28: the stateless era. No handshake and no
 * session; every request self-describes via `_meta`, mirrored into the HTTP
 * request headers. Servers never send requests back, so `onInbound` has
 * nothing to answer.
 *
 * Files here are named for the revision they implement. A later revision that
 * keeps this wire shape gets its own file re-exporting this one.
 */
import { Effect, Encoding, Option, Predicate, Record, type Scope } from "effect"
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

/**
 * Which param field carries the subject name mirrored into `Mcp-Name`, per
 * method. Keyed by string rather than `McpMethod` so the methods a later
 * revision adds need no cast here.
 */
const NAME_FIELD: Record<string, string> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
}

const subjectName = (method: McpMethod, params: unknown): Option.Option<string> =>
  Record.get(NAME_FIELD, method).pipe(
    Option.flatMap((field) => Record.get(asRecord(params), field)),
    Option.filter(Predicate.isString),
  )

const asRecord = (value: unknown): Record<string, unknown> =>
  Predicate.isObject(value) ? value : {}

const SENTINEL = /^=\?base64\?.*\?=$/
// Visible ASCII only, no leading or trailing space (RFC 9110 field values).
const HEADER_SAFE = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/

/**
 * Header values outside the safe set (and any literal that would be mistaken
 * for the marker) ride the spec's Base64 sentinel form.
 */
export const headerValue = (raw: string): string =>
  HEADER_SAFE.test(raw) && !SENTINEL.test(raw) ? raw : `=?base64?${Encoding.encodeBase64(raw)}?=`

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
