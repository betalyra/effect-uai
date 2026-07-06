/**
 * Node runner for the native-grounding recipe.
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/native-grounding/run-node.ts
 *
 *   # Swap the provider (each uses its own hosted web search):
 *   ANTHROPIC_API_KEY=... pnpm tsx recipes/native-grounding/run-node.ts --provider=anthropic
 *   OPENAI_API_KEY=...    pnpm tsx recipes/native-grounding/run-node.ts --provider=openai
 *
 *   # Ask your own question:
 *   QUESTION="who won the 2026 F1 season opener?" \
 *     pnpm tsx recipes/native-grounding/run-node.ts
 *
 * This file only attaches the Node platform HttpClient and starts the runtime;
 * composition is in `app.ts` and the loop in `recipe.ts`.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

NodeRuntime.runMain(
  main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(NodeHttpClient.layerUndici)))),
)
