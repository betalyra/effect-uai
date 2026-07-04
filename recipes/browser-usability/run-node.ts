/**
 * Node runner for the browser-usability recipe.
 *
 *   # Start obscura (partial-CDP headless engine) first:
 *   docker run -d --name obscura -p 127.0.0.1:9222:9222 h4ckf0r0day/obscura
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/browser-usability/run-node.ts
 *
 *   # Override the goal, start URL, model, or step budget:
 *   GOAL="Find the pricing page" START_URL="https://exa.ai" MAX_STEPS=8 \
 *     GOOGLE_API_KEY=... pnpm tsx recipes/browser-usability/run-node.ts
 *
 * Everything not in this file is in `app.ts` (composition + reporting) and
 * `recipe.ts` (the observe/decide/act loop). This file only attaches the
 * Node platform `HttpClient` (the model provider needs it) and starts the
 * runtime.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = NodeHttpClient.layerUndici

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
