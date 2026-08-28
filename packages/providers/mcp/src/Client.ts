/**
 * `connect` opens a scoped MCP client: transport -> rpc core -> protocol probe.
 * The protocol era is a property of the server, so it is negotiated once here
 * and fixed for the connection's lifetime. The client surface is era-uniform.
 */
import { Context, Effect, Layer, Option, Ref, type Scope } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { McpConnectFailed, type McpError, McpProtocolError } from "./McpError.js"
import { Auth, type TokenSource } from "./internal/auth.js"
import * as Handshake from "./internal/protocols/2025-06-18.js"
import * as Stateless from "./internal/protocols/2026-07-28.js"
import type { Protocol } from "./internal/protocol.js"
import { type McpConnection, open } from "./internal/rpc.js"
import {
  type CallToolResult,
  decodeCallToolResult,
  decodeListToolsResult,
  LATEST_VERSION,
  type McpMethod,
  type ProtocolVersion,
  type ServerInfo,
  type ToolInfo,
} from "./internal/schema.js"
import * as HttpTransport from "./internal/httpTransport.js"
import * as StdioTransport from "./internal/stdioTransport.js"

export { Auth, type TokenSource }

/** `auto` runs the probe; a pinned version skips detection. */
export type ProtocolPin = "auto" | ProtocolVersion

export type McpClientConfig =
  | {
      readonly transport: "http"
      readonly url: string
      /** Static, non-auth headers sent on every request. */
      readonly headers?: Record<string, string>
      /** Omit for a public server. See `Auth` for the three shapes. */
      readonly auth?: Auth
      readonly protocol?: ProtocolPin
    }
  | {
      readonly transport: "stdio"
      readonly command: string
      readonly args?: ReadonlyArray<string>
      readonly env?: Record<string, string>
      readonly cwd?: string
      readonly protocol?: ProtocolPin
    }

/**
 * Services a client needs, by transport. Both are listed because the config is
 * a runtime value: an app that only uses one still provides the other's layer,
 * which is cheap (`FetchHttpClient.layer` / `NodeServices.layer`).
 */
export type McpRequirements = HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner

export type McpServerInfo = ServerInfo & {
  /** The negotiated protocol version: the only era signal callers need. */
  readonly protocolVersion: ProtocolVersion
}

export type McpClient = {
  readonly listTools: Effect.Effect<ReadonlyArray<ToolInfo>, McpError>
  readonly callTool: (name: string, args: unknown) => Effect.Effect<CallToolResult, McpError>
  readonly serverInfo: McpServerInfo
}

const undecodable = (method: McpMethod, detail: string, raw: unknown): McpError =>
  new McpProtocolError({ method, reason: `undecodable ${method} result${detail}`, raw })

const makeClient = (connection: McpConnection, protocol: Protocol): McpClient => {
  const request = (method: McpMethod, params: unknown) =>
    connection.request(method, protocol.envelope(method, params), protocol.meta(method, params))

  return {
    listTools: request("tools/list", {}).pipe(
      Effect.flatMap((raw) =>
        decodeListToolsResult(raw).pipe(
          Effect.mapError(() => undecodable("tools/list", "", raw)),
          Effect.map((result) => result.tools),
        ),
      ),
    ),

    callTool: (name, args) =>
      request("tools/call", { name, arguments: args ?? {} }).pipe(
        Effect.flatMap((raw) =>
          decodeCallToolResult(raw).pipe(
            Effect.mapError(() => undecodable("tools/call", ` for ${name}`, raw)),
          ),
        ),
      ),

    serverInfo: { ...protocol.serverInfo, protocolVersion: protocol.version },
  }
}

/**
 * Try the stateless protocol first, then the handshake era. The stateless
 * probe yields `None` only when the server proves it is not stateless (an
 * error that is not one of the recognized modern codes), which is exactly the
 * spec's era discriminator. A pinned `protocol` skips detection.
 *
 * The result is cached for the connection's lifetime by the caller: era is a
 * property of the server, not of a request.
 */
const negotiate = (
  connection: McpConnection,
  pin: ProtocolPin,
): Effect.Effect<Protocol, McpError, Scope.Scope> => {
  if (pin === LATEST_VERSION) return required(Stateless.probe(connection))
  if (pin !== "auto") return required(Handshake.probe(connection))
  return Stateless.probe(connection).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => required(Handshake.probe(connection)),
        onSome: Effect.succeed<Protocol>,
      }),
    ),
  )
}

const required = (
  probe: Effect.Effect<Option.Option<Protocol>, McpError, Scope.Scope>,
): Effect.Effect<Protocol, McpError, Scope.Scope> =>
  probe.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new McpConnectFailed({ reason: "the server does not speak a supported MCP protocol" }),
          ),
        onSome: Effect.succeed<Protocol>,
      }),
    ),
  )

/**
 * Open a scoped client. The connection lives exactly as long as the enclosing
 * scope, so `Effect.scoped`, a `Layer`, or `Stream.scoped` all give correct
 * teardown with no explicit close.
 */
export const connect = (
  config: McpClientConfig,
): Effect.Effect<McpClient, McpError, Scope.Scope | McpRequirements> =>
  Effect.gen(function* () {
    const transport = yield* config.transport === "http"
      ? HttpTransport.make(config)
      : StdioTransport.make(config)

    // Inbound handling belongs to the protocol, which is not chosen until the
    // probe completes, so the reader reads it from a Ref that starts empty.
    // Frames arriving before then can only be legacy noise; ignore them.
    const protocolRef = yield* Ref.make(Option.none<Protocol>())
    const connection = yield* open(transport, (inbound) =>
      Ref.get(protocolRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (protocol) => protocol.onInbound(inbound),
          }),
        ),
      ),
    )

    const protocol = yield* negotiate(connection, config.protocol ?? "auto")
    yield* Ref.set(protocolRef, Option.some(protocol))

    return makeClient(connection, protocol)
  })

export class Mcp extends Context.Service<Mcp, McpClient>()(
  "@betalyra/effect-uai/providers/mcp/Mcp",
) {}

/** DI convenience for the single-server app: connects when the layer builds. */
export const layer = (config: McpClientConfig): Layer.Layer<Mcp, McpError, McpRequirements> =>
  Layer.effect(Mcp, connect(config))
