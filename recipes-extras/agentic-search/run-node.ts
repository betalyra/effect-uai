/**
 * Node runner for the agentic-search recipe.
 *
 *   pnpm -C recipes-extras/agentic-search install
 *   JINA_API_KEY=jina_... LLM_API_KEY=sk-or-... \
 *     ./recipes-extras/agentic-search/node_modules/.bin/tsx \
 *     recipes-extras/agentic-search/run-node.ts "why does the speckled band kill?"
 *
 * The first run downloads the book, chunks it, embeds it, and writes
 * `rag.db`. Later runs reuse both. Only ever run one writer at a time: the
 * libsql vector index does not tolerate concurrent writers.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
