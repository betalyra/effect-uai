/**
 * Bun runner for the deep-research recipe.
 *
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... \
 *     bun recipes/deep-research/run-bun.ts
 *
 * Only the platform HttpClient and the runtime differ from `run-node.ts`;
 * composition and the recipe body are shared in `app.ts` / `recipe.ts`.
 */
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunRuntime } from "@effect/platform-bun"
import { appLayer, main } from "./app.js"

BunRuntime.runMain(
  main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(FetchHttpClient.layer)))),
)
