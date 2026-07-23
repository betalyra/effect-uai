/**
 * Bun runner for the basic-usage recipe.
 *
 *   LLM_API_KEY=sk-or-... bun recipes/basic-usage/run-bun.ts
 *
 * Everything not in this file is in `app.ts` (composition + rendering) and
 * `recipe.ts` (the agent loop). This file only attaches the Bun platform
 * `HttpClient` and starts the runtime. Compare side-by-side with `run-node.ts`
 * to see exactly what is runtime-specific.
 */
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunRuntime } from "@effect/platform-bun"
import { appLayer, main } from "./app.js"

const platformLayer = FetchHttpClient.layer

BunRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
