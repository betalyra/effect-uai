/**
 * Node runner for the grounded-answer recipe.
 *
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... \
 *     pnpm tsx recipes/grounded-answer/run-node.ts
 *
 *   # Swap either axis independently via argv:
 *   GOOGLE_API_KEY=... PERPLEXITY_API_KEY=... \
 *     pnpm tsx recipes/grounded-answer/run-node.ts --llm=gemini --search=perplexity
 *
 *   # Ask your own question:
 *   QUESTION="who won the 2026 F1 season opener?" \
 *     pnpm tsx recipes/grounded-answer/run-node.ts
 *
 * Everything not in this file is in `app.ts` (composition) and
 * `recipe.ts` (the tool loop). This file only attaches the Node platform
 * HttpClient and starts the runtime.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

NodeRuntime.runMain(
  main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(NodeHttpClient.layerUndici)))),
)
