/**
 * Deno runner for the native-grounding recipe.
 *
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/native-grounding/run-deno.ts
 *   ANTHROPIC_API_KEY=... deno run --allow-all recipes/native-grounding/run-deno.ts --provider=anthropic
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
