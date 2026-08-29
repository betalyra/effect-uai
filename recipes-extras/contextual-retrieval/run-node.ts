/**
 * Node runner for the contextual-retrieval recipe.
 *
 *   pnpm -C recipes-extras/contextual-retrieval install
 *   JINA_API_KEY=jina_... ANTHROPIC_API_KEY=sk-ant-... \
 *     ./recipes-extras/contextual-retrieval/node_modules/.bin/tsx \
 *     recipes-extras/contextual-retrieval/run-node.ts
 *
 * The first run downloads the book, chunks it, writes one situating blurb per
 * chunk with an LLM, embeds both variants, and writes `rag.db`. That is the
 * expensive step and it happens once. Only ever run one writer at a time: the
 * libsql vector index does not tolerate concurrent writers.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
