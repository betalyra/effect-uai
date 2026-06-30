/**
 * Node runner for the market-intel recipe.
 *
 *   FIRECRAWL_API_KEY=... GOOGLE_API_KEY=... pnpm tsx recipes/market-intel/run-node.ts
 *
 *   # Override the pages, model, or concurrency:
 *   URLS="https://stripe.com/pricing,https://www.notion.so/pricing" CONCURRENCY=2 \
 *     FIRECRAWL_API_KEY=... GOOGLE_API_KEY=... pnpm tsx recipes/market-intel/run-node.ts
 *
 * Everything not in this file is in `app.ts` (composition + reporting) and
 * `recipe.ts` (read + structured extraction). This file only attaches the Node
 * platform `HttpClient` and starts the runtime.
 *
 * `NodeHttpClient.layerUndici` uses Undici, which handles long-lived streaming
 * bodies reliably; Node's built-in `fetch` does not.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = NodeHttpClient.layerUndici

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
