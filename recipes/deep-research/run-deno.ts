/**
 * Deno runner for the deep-research recipe.
 *
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... \
 *     deno run --allow-all recipes/deep-research/run-deno.ts
 *
 * Uses `@effect/platform-node` through Deno's Node-compat layer.
 * `recipes/deno.json` pins `nodeModulesDir: "manual"` so Deno resolves bare
 * specifiers against the pnpm-installed `node_modules`.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

NodeRuntime.runMain(
  main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(NodeHttpClient.layerUndici)))),
)
