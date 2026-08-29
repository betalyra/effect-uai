/**
 * The `Protocol` seam: everything that differs between the stateless
 * 2026-07-28 revision and the 2025-06-18 handshake era, behind one interface.
 * `modern.ts` and `legacy.ts` implement it independently and never import each
 * other; `Client.connect` picks one, once, from the probes.
 *
 * The negotiated `version` is the single source of truth. There is no separate
 * era label: nothing branches on it at runtime, so carrying one would only
 * create state that can drift out of sync with the version.
 */
import { Effect, Option, Predicate, type Scope } from "effect"
import type { McpError } from "../McpError.js"
import type { Inbound, McpConnection, SendMeta } from "./rpc.js"
import {
  decodeUnsupportedVersionData,
  type McpMethod,
  MODERN_ERROR_CODES,
  type ProtocolVersion,
  type ServerInfo,
} from "./schema.js"

export type Protocol = {
  readonly version: ProtocolVersion
  readonly serverInfo: ServerInfo
  /** Wrap outgoing params: modern adds the `_meta` envelope, legacy passes through. */
  readonly envelope: (method: McpMethod, params: unknown) => unknown
  /** Per-request transport hints: modern headers, or the legacy session id. */
  readonly meta: (method: McpMethod, params: unknown) => SendMeta
  /** Answer a server-initiated frame. Modern servers never send one. */
  readonly onInbound: (inbound: Inbound) => Effect.Effect<void>
}

/**
 * Probe for one protocol era. `None` means "not this era, try the next"; a
 * failure means the server is this era but unusable (no mutual version).
 */
export type ProtocolProbe = (
  connection: McpConnection,
) => Effect.Effect<Option.Option<Protocol>, McpError, Scope.Scope>

const isProtocolError = Predicate.isTagged("McpProtocolError")

/**
 * A `-32020` / `-32021` / `-32022` reply, which is the spec's era
 * discriminator: it proves the peer speaks a modern version, so the client
 * corrects and retries rather than falling back to `initialize`. `supported`
 * carries the versions a `-32022` offered, decoded through the schema so a
 * server that adds fields cannot break it.
 */
export type ModernRejection = {
  readonly code: number
  readonly supported: ReadonlyArray<string>
}

export const modernRejection = (error: McpError): Option.Option<ModernRejection> =>
  isProtocolError(error)
    ? Option.fromNullishOr(error.code).pipe(
        Option.filter((code) => MODERN_ERROR_CODES.has(code)),
        Option.map((code) => ({ code, supported: supportedVersions(error.raw) })),
      )
    : Option.none()

const supportedVersions = (raw: unknown): ReadonlyArray<string> =>
  decodeUnsupportedVersionData(Predicate.hasProperty(raw, "data") ? raw.data : undefined).pipe(
    Option.flatMap((data) => Option.fromNullishOr(data.supported)),
    Option.getOrElse((): ReadonlyArray<string> => []),
  )
