/**
 * Deno runner for the basic-metrics recipe.
 *
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/basic-metrics/run-deno.ts
 *
 * Uses `@effect/platform-node` through Deno's Node-compat layer.
 * `recipes/deno.json` pins `nodeModulesDir: "manual"` so Deno resolves bare
 * specifiers against the pnpm-installed `node_modules`. Once
 * `@effect/platform-deno` ships, the platform imports can be swapped without
 * touching `recipe.ts` or `app.ts`.
 */
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeFileSystem.layer, NodeHttpClient.layerUndici)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
