/**
 * Node runner for the storyboard recipe.
 *
 *   OPENAI_API_KEY=sk-... LLM_API_KEY=sk-... \
 *     pnpm tsx recipes/storyboard/run-node.ts
 *
 *   # Bigger panels, two re-render rounds for anything the critic rejects:
 *   ... run-node.ts --resolution 2K --rounds 2
 *
 *   # Through gateways on the same wire protocols:
 *   ... run-node.ts --base-url=https://router.requesty.ai/v1 \
 *                   --model=azure/openai/gpt-image-2
 *
 * Each run writes to `storyboard-out/<timestamp>/`, so runs accumulate
 * rather than overwrite. `--out` picks a different directory.
 *
 * Cost note: four sheets plus eight panels is twelve images before any
 * re-render, and `gpt-image-2` bills image output per token. A 2K panel
 * costs roughly four times a 1K one, so start at 1K.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
