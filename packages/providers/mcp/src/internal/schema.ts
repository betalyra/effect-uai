/**
 * Self-contained MCP wire schemas, both protocol eras. The single source of
 * truth for the wire format; nothing MCP-shaped is imported from effect.
 * Decodes are deliberately loose (unknown extra fields pass through) so
 * spec-compliant servers with richer payloads never fail the client.
 */
import { Option, Schema } from "effect"

// ---------------------------------------------------------------------------
// Protocol versions
// ---------------------------------------------------------------------------

/** Every protocol version this client can speak. */
export const ProtocolVersion = Schema.Literals(["2026-07-28", "2025-11-25", "2025-06-18"])
export type ProtocolVersion = typeof ProtocolVersion.Type

/** Newest version we speak: the stateless protocol, and what the probe tries first. */
export const LATEST_VERSION = "2026-07-28" satisfies ProtocolVersion

/** The legacy handshake era we negotiate; 2025-11-25 is wire-compatible. */
export const LEGACY_VERSION = "2025-06-18" satisfies ProtocolVersion

const isProtocolVersion = Schema.is(ProtocolVersion)

/** Narrow a server-offered version string to one we support. */
export const asProtocolVersion = (raw: string): Option.Option<ProtocolVersion> =>
  isProtocolVersion(raw) ? Option.some(raw) : Option.none()

/**
 * The JSON-RPC methods this client issues. Not to be confused with an HTTP
 * method: on Streamable HTTP every one of these travels as a POST, and the
 * name is mirrored into the `Mcp-Method` header.
 */
export const McpMethod = Schema.Literals([
  "server/discover",
  "initialize",
  "tools/list",
  "tools/call",
])
export type McpMethod = typeof McpMethod.Type

/** Modern `_meta` keys (SEP-2575): every request self-describes its protocol. */
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
/** Servers identify themselves in each *result's* `_meta`, not at the top level. */
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

export const CLIENT_INFO = { name: "@effect-uai/mcp", version: "0.12.0" }

/** Modern JSON-RPC error codes. */
export const CODE_HEADER_MISMATCH = -32020
export const CODE_MISSING_CLIENT_CAPABILITY = -32021
export const CODE_UNSUPPORTED_PROTOCOL_VERSION = -32022
export const CODE_METHOD_NOT_FOUND = -32601

/**
 * A reply carrying one of these proves the server speaks a modern version, so
 * era detection corrects and retries instead of falling back to `initialize`.
 */
export const MODERN_ERROR_CODES: ReadonlySet<number> = new Set([
  CODE_HEADER_MISMATCH,
  CODE_MISSING_CLIENT_CAPABILITY,
  CODE_UNSUPPORTED_PROTOCOL_VERSION,
])

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

export const JsonRpcId = Schema.Union([Schema.Number, Schema.String])
export type JsonRpcId = typeof JsonRpcId.Type

export const JsonRpcErrorObject = Schema.Struct({
  code: Schema.Number,
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
})
export type JsonRpcErrorObject = typeof JsonRpcErrorObject.Type

/**
 * Any inbound frame: a reply (`id` + `result`/`error`), a server-initiated
 * request (`method` + `id`), or a notification (`method`, no `id`). One
 * loose struct so the reader can classify without a union decode.
 */
export const InboundMessage = Schema.Struct({
  // Null is legal and meaningful: JSON-RPC uses it for errors raised before a
  // request could be attributed. Rejecting it would drop the frame entirely.
  id: Schema.optional(Schema.NullOr(JsonRpcId)),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(JsonRpcErrorObject),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
})
export type InboundMessage = typeof InboundMessage.Type

export const decodeInboundMessage = Schema.decodeUnknownEffect(InboundMessage)

// --- outbound frame builders -----------------------------------------------

export const requestFrame = (id: JsonRpcId, method: string, params: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })

export const notificationFrame = (method: string, params?: unknown): string =>
  JSON.stringify(
    params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params },
  )

export const resultFrame = (id: JsonRpcId, result: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, result })

export const errorFrame = (id: JsonRpcId, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })

// ---------------------------------------------------------------------------
// Shared: tools
// ---------------------------------------------------------------------------

export const ToolInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
})
export type ToolInfo = typeof ToolInfo.Type

/**
 * Modern list results may carry cache metadata (`ttlMs` / `cacheScope`);
 * v1 reads but does not act on them (input for a later refresh feature).
 */
export const ListToolsResult = Schema.Struct({
  tools: Schema.Array(ToolInfo),
  nextCursor: Schema.optional(Schema.String),
  ttlMs: Schema.optional(Schema.Number),
  cacheScope: Schema.optional(Schema.String),
})
export type ListToolsResult = typeof ListToolsResult.Type

export const decodeListToolsResult = Schema.decodeUnknownEffect(ListToolsResult)

// --- content blocks ---------------------------------------------------------

export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})
export type TextContent = typeof TextContent.Type

/** Non-text blocks (image / audio / resource) are placeholder-summarized in v1. */
export const OtherContent = Schema.Struct({
  type: Schema.String,
})

export const ContentBlock = Schema.Union([TextContent, OtherContent])
export type ContentBlock = typeof ContentBlock.Type

export const isTextContent = Schema.is(TextContent)

export const CallToolResult = Schema.Struct({
  content: Schema.optionalKey(Schema.Array(ContentBlock)),
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  // Required on modern results; absent on legacy ones.
  resultType: Schema.optional(Schema.String),
})
export type CallToolResult = typeof CallToolResult.Type

export const decodeCallToolResult = Schema.decodeUnknownEffect(CallToolResult)

// ---------------------------------------------------------------------------
// Modern era (2026-07-28)
// ---------------------------------------------------------------------------

export const ServerInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
})
export type ServerInfo = typeof ServerInfo.Type

/** The subset of a result's `_meta` we read. */
export const ResultMeta = Schema.Struct({
  [META_SERVER_INFO]: Schema.optional(ServerInfo),
})
export type ResultMeta = typeof ResultMeta.Type

export const DiscoverResult = Schema.Struct({
  supportedVersions: Schema.Array(Schema.String),
  capabilities: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  // Spec-conformant servers put identity in `_meta`; a top-level `serverInfo`
  // is accepted too, since that is where the legacy handshake carries it.
  _meta: Schema.optional(ResultMeta),
  serverInfo: Schema.optional(ServerInfo),
  instructions: Schema.optional(Schema.String),
})
export type DiscoverResult = typeof DiscoverResult.Type

export const decodeDiscoverResult = Schema.decodeUnknownEffect(DiscoverResult)

/**
 * `data` of a `-32022` UnsupportedProtocolVersionError reply. Decoded, not
 * hand-parsed: the shape is server-controlled and may carry extra fields.
 */
export const UnsupportedVersionData = Schema.Struct({
  supported: Schema.optional(Schema.Array(Schema.String)),
  requested: Schema.optional(Schema.NullOr(Schema.String)),
})
export type UnsupportedVersionData = typeof UnsupportedVersionData.Type

export const decodeUnsupportedVersionData = Schema.decodeUnknownOption(UnsupportedVersionData)

// ---------------------------------------------------------------------------
// Legacy era (2025-06-18 / 2025-11-25)
// ---------------------------------------------------------------------------

export const InitializeResult = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  serverInfo: Schema.optional(ServerInfo),
  instructions: Schema.optional(Schema.String),
})
export type InitializeResult = typeof InitializeResult.Type

export const decodeInitializeResult = Schema.decodeUnknownEffect(InitializeResult)
