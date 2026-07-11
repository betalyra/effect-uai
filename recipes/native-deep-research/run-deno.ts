/**
 * Deno runner for the native-deep-research recipe.
 *
 *   PERPLEXITY_API_KEY=... deno run --allow-all recipes/native-deep-research/run-deno.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/native-deep-research/run-deno.ts --provider=openai
 *
 * Uses `@effect/platform-node` through Deno's Node-compat layer.
 * `recipes/deno.json` pins `nodeModulesDir: "manual"` so Deno resolves bare
 * specifiers against the pnpm-installed `node_modules`.
 */
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeFileSystem.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
