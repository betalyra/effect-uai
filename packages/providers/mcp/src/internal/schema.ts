/**
 * Self-contained MCP wire schemas, both protocol eras. The single source of
 * truth for the wire format; nothing MCP-shaped is imported from effect.
 * Decodes are deliberately loose (unknown extra fields pass through) so
 * spec-compliant servers with richer payloads never fail the client.
 */
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Protocol versions
// ---------------------------------------------------------------------------

/** The modern, stateless era (the core model). */
export const MODERN_VERSION = "2026-07-28"

/** The legacy handshake era we negotiate; 2025-11-25 is wire-compatible. */
export const LEGACY_VERSION = "2025-06-18"
export const LEGACY_VERSIONS: ReadonlyArray<string> = ["2025-06-18", "2025-11-25"]

/** Modern `_meta` keys (SEP-2575): every request self-describes its protocol. */
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"

export const CLIENT_INFO = { name: "@effect-uai/mcp", version: "0.12.0" }

/** Modern JSON-RPC error codes. */
export const CODE_HEADER_MISMATCH = -32020
export const CODE_UNSUPPORTED_PROTOCOL_VERSION = -32022
export const CODE_METHOD_NOT_FOUND = -32601

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
  id: Schema.optional(JsonRpcId),
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

const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})

/** Non-text blocks (image / audio / resource) are placeholder-summarized in v1. */
const OtherContent = Schema.Struct({
  type: Schema.String,
})

export const ContentBlock = Schema.Union([TextContent, OtherContent])
export type ContentBlock = typeof ContentBlock.Type

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

export const DiscoverResult = Schema.Struct({
  supportedVersions: Schema.Array(Schema.String),
  capabilities: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  serverInfo: Schema.optional(ServerInfo),
  instructions: Schema.optional(Schema.String),
})
export type DiscoverResult = typeof DiscoverResult.Type

export const decodeDiscoverResult = Schema.decodeUnknownEffect(DiscoverResult)

/** `data` of a `-32022` UnsupportedProtocolVersionError reply. */
export const UnsupportedVersionData = Schema.Struct({
  supported: Schema.optional(Schema.Array(Schema.String)),
})

export const decodeUnsupportedVersionData = Schema.decodeUnknownEffect(UnsupportedVersionData)

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
