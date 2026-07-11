/**
 * Node runner for the native-deep-research recipe.
 *
 *   PERPLEXITY_API_KEY=... pnpm tsx recipes/native-deep-research/run-node.ts
 *
 *   # Swap the provider (each runs its own hosted deep-research job):
 *   OPENAI_API_KEY=... pnpm tsx recipes/native-deep-research/run-node.ts --provider=openai
 *
 *   # Ask your own question (runs for minutes, server-side):
 *   QUESTION="compare the leading open-weight LLMs released this quarter" \
 *     pnpm tsx recipes/native-deep-research/run-node.ts
 *
 * This file only attaches the Node platform HttpClient and starts the runtime;
 * composition is in `app.ts` and the recipe body in `recipe.ts`.
 */
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeFileSystem.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
