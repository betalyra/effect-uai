/**
 * Runner for the mcp-tools recipe. Same file on every runtime:
 *
 *   LLM_API_KEY=... pnpm tsx recipes/mcp-tools/run.ts
 *   LLM_API_KEY=... bun recipes/mcp-tools/run.ts
 *   LLM_API_KEY=... deno run --allow-all recipes/mcp-tools/run.ts
 *
 *   # Another Streamable HTTP server, its tools under your own prefix:
 *   ... run.ts --mcp-url https://example.com/mcp --prefix ex --mcp-token-env EX_TOKEN
 *
 * Defaults point at Hugging Face's public MCP server, so no MCP token is
 * needed to see it work.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
