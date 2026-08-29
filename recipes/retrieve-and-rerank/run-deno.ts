/**
 * Deno runner for the retrieve-and-rerank recipe.
 *
 *   JINA_API_KEY=jina_... deno run --allow-all recipes/retrieve-and-rerank/run-deno.ts
 *
 * Uses `@effect/platform-node` through Deno's Node-compat layer;
 * `recipes/deno.json` pins `nodeModulesDir: "manual"` so bare specifiers
 * resolve against the pnpm-installed `node_modules`.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
