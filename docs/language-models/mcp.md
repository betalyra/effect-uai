---
title: MCP
description: "Connect to a Model Context Protocol server and turn its tools into a Toolkit the loop runs like any other."
---

The Model Context Protocol is how a growing number of services expose their
tools to a model: Hugging Face, Linear, DeepWiki, Microsoft Learn, and whatever
you run locally. `@effect-uai/mcp` is a client for it. Point it at a server and
you get back an ordinary [`Toolkit`](/language-models/tools/), so from the
loop's point of view nothing about MCP is special.

```bash
pnpm add @effect-uai/mcp
```

## Quickstart

```ts
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { connect } from "@effect-uai/mcp/Client"
import { mcpToolkit } from "@effect-uai/mcp/Toolkit"

const program = Effect.gen(function* () {
  const client = yield* connect({
    transport: "http",
    url: "https://huggingface.co/mcp",
  })

  const toolkit = yield* mcpToolkit(client, { prefix: "hf" })
  // hf__hub_repo_search, hf__model_detail, ...
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)))
```

Pass that toolkit to `streamTurn` and `Toolkit.run` like any other. The
[MCP tools recipe](/recipes/mcp-tools/) is a full loop against a live server.

## The connection is a scoped resource

`connect` returns `Effect<McpClient, McpError, Scope>`. There is no `close()`
to call: the scope you run it in decides how long the connection lives.

- **`Effect.scoped`**: as long as this Effect.
- **`Stream.scoped`**: as long as the stream. You do not have to drain the
  stream for the connection to be released; interrupting it is enough.
- **`layer(config)`**: connects when the layer builds, releases when the
  application shuts down. The single-server app wants this one.

```ts
import { layer, Mcp } from "@effect-uai/mcp/Client"

const mcpLayer = layer({ transport: "http", url: "https://huggingface.co/mcp" })

const useIt = Effect.gen(function* () {
  const client = yield* Mcp
  return yield* client.listTools
})
```

## Tools from a server

`mcpToolkit(client, options?)` asks the server what it offers and builds one
tool per entry. The server's own schema is what the model sees, and the server
validates the arguments it gets back.

`prefix` namespaces every tool as `<prefix>__<name>`, which matters as soon as
you have two sources. Generic names like `search` collide, and
[`Toolkit.compose`](/language-models/tools/#composing-toolkits) tells you so
rather than silently overwriting one:

```ts
const kit =
  yield *
  Toolkit.compose(
    Toolkit.make(getCurrentTime, sendEmail),
    yield * mcpToolkit(hf, { prefix: "hf" }),
    yield * mcpToolkit(wiki, { prefix: "wiki" }),
  )
```

The tool list is read once, when you build the toolkit. If the server drops a
tool afterwards, calling it comes back as an ordinary `unknown_tool` result the
model can react to, not a crash.

## Transports

**Streamable HTTP** for a remote server. Needs an `HttpClient`:

```ts
connect({
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  headers: { "x-tenant": "acme" },
})
```

On Node, provide `NodeHttpClient.layerUndici` rather than the built-in `fetch`,
which drops the long-lived response bodies some servers use.

**stdio** for a server you run locally. Needs a `ChildProcessSpawner`, which
comes with the platform services layer (`NodeServices.layer`):

```ts
connect({
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  env: { LOG_LEVEL: "debug" },
})
```

The process starts with the connection and is killed when the scope closes.

## Authentication

Omit `auth` and you connect anonymously, which is what public servers want. A
token-gated server takes one of three shapes:

```ts
import { Auth } from "@effect-uai/mcp/Client"

// A fixed token. The common case.
Auth.Static({ token: Redacted.make(process.env.LINEAR_API_KEY!) })

// Read before every request: rotation, refresh, a vault lookup.
Auth.TokenSource({ token: myTokenEffect })
```

Both send an `Authorization` header (`scheme` overrides the default `Bearer`).
Tokens are `Redacted` throughout, so they do not surface in logs or error
causes.

If a server wants credentials you did not supply, the connection fails with
`McpAuthRequired`, carrying whatever the server said about how to obtain them.

## Protocol versions

Servers are spread across several revisions of the protocol, and this client
speaks all the current ones:

| Revision     | Status                                              |
| ------------ | --------------------------------------------------- |
| `2026-07-28` | Current.                                            |
| `2025-11-25` | Supported.                                          |
| `2025-06-18` | Supported.                                          |
| `2025-03-26` | Not supported; fails with `McpUnsupportedProtocol`. |

You do not choose. `connect` works out what the server speaks and settles on it
for the life of the connection, and every version behaves identically from
there. `client.serverInfo.protocolVersion` reports what was agreed, and a
server upgrading its protocol needs no change on your side.

Two things are worth knowing about the older revisions, neither of which
changes your code. Connecting costs one extra round-trip, because those servers
open with a handshake before they will answer anything. And a server on those
revisions may send requests back to the client, asking it to run a model or
prompt the user; this client declines those (see below), so a server that
depends on them will be less capable here than one on `2026-07-28`.

If you already know what a server speaks and want to skip the negotiation,
pin it:

```ts
connect({ transport: "http", url, protocol: "2026-07-28" })
```

## Failures

Two channels, matching the [tool failure model](/language-models/tools/#failures).

**A tool reporting an error** is the server telling the model it went wrong.
That arrives as a model-visible `ToolResult.Failure`, and models generally read
it and retry with corrected arguments.

**Connection and protocol failures** propagate typed as `McpError` on
`Toolkit.run`: `McpConnectFailed`, `McpUnsupportedProtocol`,
`McpProtocolError`, `McpTransportClosed`, `McpAuthRequired`, `McpAuthError`.
Branch on `_tag` to handle them, or show them to the model instead of ending
the loop:

```ts
import * as McpError from "@effect-uai/mcp/McpError"

Toolkit.describeFailures(kit, McpError.describe)
```

## What's not built in

- **Tools only.** MCP resources and prompts are not exposed.
- **Client only.** This package connects to servers; it does not host one.
- **No sampling, elicitation, or roots.** A server asking for these gets a
  clean refusal rather than being left waiting.
- **No interactive tool responses.** A tool that asks the user a question
  mid-call fails with `McpProtocolError`.

## Next

- [MCP tools recipe](/recipes/mcp-tools/): a full loop against a live server,
  with and without authentication.
- [Tools and toolkits](/language-models/tools/): what a `Toolkit` is, and how
  `run`, composition, and failures work.
