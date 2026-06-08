/**
 * Deno runner for the grounded-answer recipe.
 *
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... \
 *     deno run --allow-all recipes/grounded-answer/run-deno.ts
 *
 *   # Swap either axis independently via argv:
 *   GOOGLE_API_KEY=... PERPLEXITY_API_KEY=... \
 *     deno run --allow-all recipes/grounded-answer/run-deno.ts --llm=gemini
 *
 * Uses `@effect/platform-node` through Deno's Node-compat layer.
 * `recipes/deno.json` pins `nodeModulesDir: "manual"` so Deno resolves
 * bare specifiers against the pnpm-installed `node_modules`. Once
 * `@effect/platform-deno` ships, the platform import can be swapped over
 * without touching `recipe.ts` or `app.ts`.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

NodeRuntime.runMain(
  main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(NodeHttpClient.layerUndici)))),
)
