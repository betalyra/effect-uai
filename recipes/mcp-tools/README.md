---
title: MCP tools
description: "Turn any MCP server's tools into a Toolkit and run them in the agent loop."
source: recipes/mcp-tools
icon: PiPlugsConnected
---

Connect to a Model Context Protocol server, turn the tools it offers into a
`Toolkit`, and let the model use them. The default target is Hugging Face's MCP
server, which is public and needs no key, so this runs with nothing but a model
API key:

```bash
LLM_API_KEY=sk-or-... pnpm tsx recipes/mcp-tools/run-node.ts
```

Also runs on Bun (`bun recipes/mcp-tools/run-bun.ts`) and Deno
(`deno run --allow-all recipes/mcp-tools/run-deno.ts`).

## What it shows

**MCP tools are ordinary tools.** Once `mcpToolkit` has run, the agent loop is
byte-for-byte the one in `basic-usage`. The toolkit came off a server instead of
a literal; nothing else changes.

**Connection lifetime = stream lifetime.** The recipe is one `Stream`:

```ts
Stream.fromEffect(connect(config)).pipe(
  Stream.mapEffect(mcpToolkit),
  Stream.flatMap(runLoop),
  Stream.scoped,
)
```

The connection opens when the stream is first pulled and closes when it ends,
fails, or is interrupted. You never close a client by hand, and you do not have
to drain the stream to release the server.

**The protocol version is invisible.** `connect` works out what the server
speaks and sticks with it. The same code drives every server below, and one
upgrading its protocol needs no change here.

## Flags

| Flag              | Default                        | Meaning                                                  |
| ----------------- | ------------------------------ | -------------------------------------------------------- |
| `--mcp-url`       | `https://huggingface.co/mcp`   | any Streamable HTTP MCP server                           |
| `--mcp-token-env` | `MCP_TOKEN`                    | name of the env var holding the server's token           |
| `--prefix`        | `hf`                           | namespace for the server's tools (`hf__hub_repo_search`) |
| `--prompt`        | a Whisper model comparison     | what to ask                                              |
| `--model`         | `openai/gpt-4o-mini`           | model id                                                 |
| `--base-url`      | `https://openrouter.ai/api/v1` | Responses-compatible endpoint                            |

Point it at a different server and ask it something else:

```bash
LLM_API_KEY=... pnpm tsx recipes/mcp-tools/run-node.ts \
  --mcp-url https://mcp.deepwiki.com/mcp --prefix wiki \
  --prompt "What does effect-smol's Queue.end do?"
```

## Authentication

A token-gated server takes `Auth.Static`. `--mcp-token-env` names the
**environment variable** holding the token rather than the token itself, so no
secret lands in `ps` output or shell history:

```bash
LLM_API_KEY=... LINEAR_API_KEY=lin_api_... \
  pnpm tsx recipes/mcp-tools/run-node.ts \
  --mcp-url https://mcp.linear.app/mcp --mcp-token-env LINEAR_API_KEY \
  --prefix linear --prompt "show me my backlog tickets"
```

Leave the flag off and the connection is anonymous, which is what public
servers want. See [MCP](/language-models/mcp/) for the other `Auth` shapes.

## Composing with your own tools

`--prefix` maps to `Toolkit.namespace`, so a server's generic `search` becomes
`<prefix>__search` and survives `compose` next to your own tools:

```ts
const kit =
  yield *
  Toolkit.compose(
    Toolkit.make(getCurrentTime, sendEmail),
    yield * mcpToolkit(hf, { prefix: "hf" }),
    yield * mcpToolkit(wiki, { prefix: "wiki" }),
  )
```

## Failure model

Two channels, no new concepts. A tool that reports an error becomes a
model-visible `ToolResult.Failure` the model reads and adapts to, usually by
fixing its arguments and trying again. A connection or protocol failure
propagates typed as `McpError` on `Toolkit.run`. To show the model those too:

```ts
Toolkit.describeFailures(kit, McpError.describe)
```
