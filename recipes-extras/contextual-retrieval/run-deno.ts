/**
 * Deno runner for the contextual-retrieval recipe.
 *
 *   JINA_API_KEY=jina_... ANTHROPIC_API_KEY=sk-ant-... \
 *     deno run --allow-ffi --allow-read --allow-write --allow-env --allow-net \
 *     recipes-extras/contextual-retrieval/run-deno.ts
 *
 * `--allow-ffi` is the one that matters: the libsql client loads a native
 * binding. Without it the store fails at layer construction.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
