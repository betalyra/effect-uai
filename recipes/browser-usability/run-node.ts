/**
 * Node runner for the browser-usability recipe.
 *
 *   # Start a headless Chromium with its DevTools port open:
 *   docker run -d --name chromium -p 127.0.0.1:9222:9222 chromedp/headless-shell
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/browser-usability/run-node.ts
 *
 *   # Override the goal, start URL, model, or step budget:
 *   GOAL="Find the pricing page" START_URL="https://exa.ai" MAX_STEPS=8 \
 *     GOOGLE_API_KEY=... pnpm tsx recipes/browser-usability/run-node.ts
 *
 * Everything not in this file is in `app.ts` (composition + reporting) and
 * `recipe.ts` (the agent loop). This file only attaches the Node platform
 * `HttpClient` (the model provider needs it) and starts the runtime.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = NodeHttpClient.layerUndici

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
