/**
 * Bun runner for the mcp-tools recipe.
 *
 *   LLM_API_KEY=sk-or-... bun recipes/mcp-tools/run-bun.ts
 *
 * Compare side-by-side with `run-node.ts`: only the platform layers differ.
 */
import { Effect, Layer } from "effect"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { FetchHttpClient } from "effect/unstable/http"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(FetchHttpClient.layer, BunServices.layer)

BunRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
