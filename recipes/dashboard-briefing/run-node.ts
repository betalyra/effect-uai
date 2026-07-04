/**
 * Node runner for the dashboard-briefing recipe.
 *
 *   # Start a real headless Chromium with its DevTools port open:
 *   docker run -d --name chromium -p 127.0.0.1:9222:9222 chromedp/headless-shell
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/dashboard-briefing/run-node.ts
 *
 *   # Point it at your own dashboard:
 *   DASHBOARD_URL="https://plausible.io/share/yoursite.com?auth=..." \
 *     GOOGLE_API_KEY=... pnpm tsx recipes/dashboard-briefing/run-node.ts
 *
 * Everything not in this file is in `app.ts` (composition + reporting) and
 * `recipe.ts` (screenshot + one vision turn). This file only attaches the
 * Node platform `HttpClient` and starts the runtime.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = NodeHttpClient.layerUndici

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
