/**
 * Node runner for the mcp-tools recipe.
 *
 *   LLM_API_KEY=sk-or-... pnpm tsx recipes/mcp-tools/run-node.ts
 *
 *   # Any other Streamable HTTP MCP server; the protocol version is detected:
 *   LLM_API_KEY=... pnpm tsx recipes/mcp-tools/run-node.ts \
 *     --mcp-url https://mcp.deepwiki.com/mcp --prefix wiki --prompt "..."
 *
 * This file only attaches the platform layers. `NodeServices` supplies `Stdio`
 * (the flags) and `NodeHttpClient.layerUndici` supplies the `HttpClient` used
 * by both the model and the MCP transport. Undici handles long-lived SSE
 * bodies reliably; Node's built-in `fetch` does not.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
