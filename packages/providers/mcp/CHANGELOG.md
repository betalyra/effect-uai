# @effect-uai/mcp

## 0.14.0

## 0.13.0

### Minor Changes

- 8abb609: New `@effect-uai/mcp`, a Model Context Protocol client. Point it at a server and
  its tools become a `Toolkit` the loop runs like any other, so an MCP tool and a
  local one are the same thing to your agent.

  ```ts
  import * as Client from "@effect-uai/mcp/Client"
  import { mcpToolkit } from "@effect-uai/mcp/Toolkit"

  const program = Effect.gen(function* () {
    const client = yield* Client.connect({ transport: "http", url: "https://mcp.deepwiki.com/mcp" })
    const toolkit = yield* mcpToolkit(client)
    return yield* streamTurn({ history, model, tools: toolkit })
  })
  ```

  - **Both transports.** `http` for hosted servers, `stdio` for a local process.
  - **Protocol era detected, not configured.** Servers span three revisions
    (`2025-06-18`, `2025-11-25`, `2026-07-28`), split across a handshake era and
    a stateless one. `connect` probes once per connection and caches the result;
    pin it with `protocol` to skip detection.
  - **Auth as a seam.** `Auth.Static` for a fixed token, `Auth.TokenSource` to
    re-read before every request, `Auth.OAuth` for built-in OAuth 2.1. Tokens
    stay `Redacted` until the wire boundary.
  - **Server-owned validation.** The input schema is a passthrough carrying the
    server's JSON Schema verbatim, so the model sees the real thing rather than a
    re-derived approximation.
  - **`Toolkit` composition.** `mcpToolkit(client, { prefix })` namespaces tools
    as `<prefix>__<name>`, so several servers combine without collisions.

  Connection lifetime is scope lifetime: `Client.layer` closes the transport when
  the scope closes. See [MCP](https://effect-uai.betalyra.com/language-models/mcp/)
  and the [MCP tools recipe](https://effect-uai.betalyra.com/recipes/mcp-tools/).

  See [Migrating to 0.13](https://effect-uai.betalyra.com/migrations/v0-13/).
