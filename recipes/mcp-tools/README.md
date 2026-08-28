---
title: MCP tools
description: "Turn any MCP server's tools into a Toolkit and run them in the agent loop."
source: recipes/mcp-tools
---

Connect to a Model Context Protocol server, turn its advertised tools into a
`Toolkit`, and let the model use them. The default target is Hugging Face's MCP
server: public, keyless, and on the stateless **2026-07-28** protocol revision.

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
fails, or is interrupted. Nothing has to be drained inside a scope and no client
is ever closed by hand.

**Protocol era is invisible.** `connect` negotiates the era once and caches it.
The same code runs against a stateless 2026-07-28 server and a 2025-06-18
handshake server, so a server upgrading its protocol needs no change here.

## Flags

| Flag         | Default                        | Meaning                                                  |
| ------------ | ------------------------------ | -------------------------------------------------------- |
| `--mcp-url`  | `https://huggingface.co/mcp`   | any Streamable HTTP MCP server                           |
| `--prefix`   | `hf`                           | namespace for the server's tools (`hf__hub_repo_search`) |
| `--prompt`   | a Whisper model comparison     | what to ask                                              |
| `--model`    | `openai/gpt-4o-mini`           | model id                                                 |
| `--base-url` | `https://openrouter.ai/api/v1` | Responses-compatible endpoint                            |

Point it at a handshake-era server to watch era detection do its job:

```bash
LLM_API_KEY=... pnpm tsx recipes/mcp-tools/run-node.ts \
  --mcp-url https://mcp.deepwiki.com/mcp --prefix wiki \
  --prompt "What does effect-smol's Queue.end do?"
```

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

Two channels, no new concepts. A tool that reports `isError` becomes a
model-visible `ToolResult.Failure` the model reads and adapts to. A transport or
protocol failure propagates typed as `McpError` on `Toolkit.run`. To show the
model those too:

```ts
Toolkit.describeFailures(kit, McpError.describe)
```
