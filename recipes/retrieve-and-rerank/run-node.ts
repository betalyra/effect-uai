/**
 * Node runner for the retrieve-and-rerank recipe.
 *
 *   JINA_API_KEY=jina_... pnpm tsx recipes/retrieve-and-rerank/run-node.ts
 *
 *   # With the grounded answer, and one of the other demo questions:
 *   JINA_API_KEY=jina_... LLM_API_KEY=sk-or-... \
 *     pnpm tsx recipes/retrieve-and-rerank/run-node.ts \
 *     --question "How long are audit logs kept in the EU region?"
 *
 *   # Widen the candidate set, keep more context:
 *   ... run-node.ts --candidates 25 --keep 6
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
