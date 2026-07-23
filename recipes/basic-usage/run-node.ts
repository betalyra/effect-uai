/**
 * Node runner for the basic-usage recipe.
 *
 *   LLM_API_KEY=sk-or-... pnpm tsx recipes/basic-usage/run-node.ts
 *
 *   # Point at any OpenAI-compatible gateway / model via flags:
 *   LLM_API_KEY=... pnpm tsx recipes/basic-usage/run-node.ts \
 *     --base-url https://router.requesty.ai/v1 --model moonshotai/kimi-k3 --provider requesty
 *
 * Everything not in this file is in `app.ts` (composition + rendering) and
 * `recipe.ts` (the agent loop). This file only attaches the Node platform
 * `HttpClient` and starts the runtime.
 *
 * `NodeHttpClient.layerUndici` uses Undici, which handles long-lived SSE
 * streaming bodies reliably; Node's built-in `fetch` does not.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = NodeHttpClient.layerUndici

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
