/**
 * Node runner for the deep-research recipe.
 *
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... \
 *     pnpm tsx recipes/deep-research/run-node.ts
 *
 *   # Swap either axis; ask your own question; fan out the sub-agents:
 *   QUESTION="compare managed Postgres providers" CONCURRENCY=3 \
 *     pnpm tsx recipes/deep-research/run-node.ts --llm=gemini --search=tavily
 *
 * Composition and rendering live in `app.ts` / `recipe.ts`; this file only
 * attaches the Node platform HttpClient and starts the runtime.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

NodeRuntime.runMain(
  main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(NodeHttpClient.layerUndici)))),
)
