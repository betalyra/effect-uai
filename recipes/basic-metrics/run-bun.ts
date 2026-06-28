/**
 * Bun runner for the basic-metrics recipe.
 *
 *   GOOGLE_API_KEY=... bun recipes/basic-metrics/run-bun.ts
 *
 * Everything not in this file is in `app.ts` (composition + logging) and
 * `recipe.ts` (the metered generation). This file only attaches the Bun
 * platform layers (HttpClient + FileSystem) and starts the runtime. Compare
 * side-by-side with `run-node.ts` to see exactly what is runtime-specific.
 */
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunFileSystem, BunRuntime } from "@effect/platform-bun"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(BunFileSystem.layer, FetchHttpClient.layer)

BunRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
