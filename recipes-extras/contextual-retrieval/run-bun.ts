/**
 * Bun runner for the contextual-retrieval recipe.
 *
 *   JINA_API_KEY=jina_... ANTHROPIC_API_KEY=sk-ant-... \
 *     bun recipes-extras/contextual-retrieval/run-bun.ts
 *
 * Compare side-by-side with `run-node.ts`: only the platform layers differ.
 * The libsql native binding loads through Bun's napi support.
 */
import { Effect, Layer } from "effect"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { FetchHttpClient } from "effect/unstable/http"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(FetchHttpClient.layer, BunServices.layer)

BunRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
