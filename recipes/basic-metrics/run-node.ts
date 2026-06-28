/**
 * Node runner for the basic-metrics recipe.
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/basic-metrics/run-node.ts
 *
 *   # Override the prompt / model / output file:
 *   PROMPT="a story about a clockwork dragon" OUTPUT_FILE=dragon.txt \
 *     GOOGLE_API_KEY=... pnpm tsx recipes/basic-metrics/run-node.ts
 *
 * Everything not in this file is in `app.ts` (composition + logging) and
 * `recipe.ts` (the metered generation). This file only attaches the Node
 * platform layers (HttpClient + FileSystem) and starts the runtime.
 *
 * `NodeHttpClient.layerUndici` uses Undici, which handles long-lived SSE
 * streaming bodies reliably; Node's built-in `fetch` does not.
 */
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeFileSystem.layer, NodeHttpClient.layerUndici)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
