/**
 * Bun runner for the market-intel recipe.
 *
 *   FIRECRAWL_API_KEY=... GOOGLE_API_KEY=... bun recipes/market-intel/run-bun.ts
 *
 * Everything not in this file is in `app.ts` (composition + reporting) and
 * `recipe.ts` (read + structured extraction). This file only attaches the Bun
 * platform `HttpClient` and starts the runtime. Compare side-by-side with
 * `run-node.ts` to see exactly what is runtime-specific.
 */
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunRuntime } from "@effect/platform-bun"
import { appLayer, main } from "./app.js"

const platformLayer = FetchHttpClient.layer

BunRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
