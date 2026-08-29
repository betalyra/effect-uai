/**
 * Node runner for the hybrid-rag recipe.
 *
 *   pnpm -C recipes-extras/hybrid-rag install
 *   JINA_API_KEY=jina_... LLM_API_KEY=sk-or-... \
 *     ./recipes-extras/hybrid-rag/node_modules/.bin/tsx \
 *     recipes-extras/hybrid-rag/run-node.ts "why does the speckled band kill?"
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
