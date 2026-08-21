import { Data, Match } from "effect"

/**
 * Transport could not establish: DNS / TLS / non-2xx on the first request,
 * a failed spawn, or a failed era probe. The raw transport error on `raw`.
 */
export class McpConnectFailed extends Data.TaggedError("McpConnectFailed")<{
  reason?: string
  raw?: unknown
}> {}

/**
 * Negotiation ended on a protocol version this client does not support
 * (e.g. a 2025-03-26-only server, or a modern server whose `supported`
 * list has no mutual version). `offered` is what the server proposed.
 */
export class McpUnsupportedProtocol extends Data.TaggedError("McpUnsupportedProtocol")<{
  offered: ReadonlyArray<string>
  reason?: string
}> {}

/**
 * A JSON-RPC error reply (carrying its `code`), a reply that failed to
 * decode, or an unsupported protocol feature (v1 fails `input_required`
 * results here). `method` names the request that was in flight.
 */
export class McpProtocolError extends Data.TaggedError("McpProtocolError")<{
  method?: string
  code?: number
  reason?: string
  raw?: unknown
}> {}

/**
 * The connection dropped with a request in flight, or a legacy session
 * expired (HTTP 404 on a known `Mcp-Session-Id`). Not resumable; the
 * remedy is reconnecting and re-issuing the request.
 */
export class McpTransportClosed extends Data.TaggedError("McpTransportClosed")<{
  method?: string
  reason?: string
  raw?: unknown
}> {}

/**
 * The server answered `401`. `resourceMetadataUrl` is the RFC 9728
 * Protected Resource Metadata pointer parsed from `WWW-Authenticate`,
 * when present; an OAuth layer starts discovery there.
 */
export class McpAuthRequired extends Data.TaggedError("McpAuthRequired")<{
  resourceMetadataUrl?: string
  wwwAuthenticate?: string
}> {}

/** A `TokenSource` / OAuth grant failed to mint or refresh a token. */
export class McpAuthError extends Data.TaggedError("McpAuthError")<{
  reason?: string
  raw?: unknown
}> {}

export type McpError =
  | McpConnectFailed
  | McpUnsupportedProtocol
  | McpProtocolError
  | McpTransportClosed
  | McpAuthRequired
  | McpAuthError

const withReason = (base: string, reason: string | undefined): string =>
  reason === undefined ? base : `${base}: ${reason}`

/**
 * Short human-readable description of an error, for logs and model-facing
 * failure messages (`Toolkit.describeFailures(McpError.describe)`). Prose,
 * not a contract; branch on `_tag` instead.
 */
export const describe: (e: McpError) => string = Match.type<McpError>().pipe(
  Match.discriminatorsExhaustive("_tag")({
    McpConnectFailed: (e) => withReason("could not connect to the MCP server", e.reason),
    McpUnsupportedProtocol: (e) =>
      `the MCP server only offers unsupported protocol versions (${e.offered.join(", ")})`,
    McpProtocolError: (e) =>
      withReason(
        `the MCP server rejected ${e.method ?? "the request"}${
          e.code === undefined ? "" : ` (${e.code})`
        }`,
        e.reason,
      ),
    McpTransportClosed: (e) => withReason("the MCP connection closed", e.reason),
    McpAuthRequired: () => "the MCP server requires authentication",
    McpAuthError: (e) => withReason("MCP authentication failed", e.reason),
  }),
)
