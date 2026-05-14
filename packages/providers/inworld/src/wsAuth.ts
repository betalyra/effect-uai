/**
 * Inworld WS auth helper. The Inworld realtime endpoints (`/tts/...` and
 * `/stt/...`) require `Authorization: Basic <API_KEY>` on the WS upgrade
 * — the docs document a `?Authorization=…` query-param variant, but in
 * practice the server returns `authentication is required` for that
 * path. Header auth is what Inworld's own samples use.
 *
 * Headers on a WS upgrade aren't settable via `globalThis.WebSocket`, so
 * we use the `ws` peer dep (Node/Bun only).
 */
import { Redacted } from "effect"
import type * as Socket from "effect/unstable/socket/Socket"
import { WebSocket as WSWebSocket } from "ws"
import { authHeader } from "./codec.js"

export const authedWsConstructor =
  (apiKey: Redacted.Redacted): Socket.WebSocketConstructor["Service"] =>
  (url) =>
    new WSWebSocket(url, undefined, {
      headers: { Authorization: authHeader(apiKey) },
    }) as unknown as globalThis.WebSocket
