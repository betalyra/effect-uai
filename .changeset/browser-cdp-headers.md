---
"@effect-uai/browser": minor
---

`CdpConnectConfig` gains an optional `headers`, sent on the CDP WebSocket handshake. Use it for an endpoint that wants an `Authorization: Bearer <token>` header, such as obscura 0.2.3 and later with `OBSCURA_CDP_TOKEN` set. Handshake headers need Node or Bun; a browser cannot set them.

A command sent after the CDP connection has ended now fails with `CdpError` of kind `closed` instead of waiting for a connection that never comes.
