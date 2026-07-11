/**
 * Bun runner for the native-deep-research recipe.
 *
 *   PERPLEXITY_API_KEY=... bun recipes/native-deep-research/run-bun.ts
 *   OPENAI_API_KEY=... bun recipes/native-deep-research/run-bun.ts --provider=openai
 *
 * Only the platform HttpClient and the runtime differ from `run-node.ts`;
 * composition and the recipe body are shared in `app.ts` / `recipe.ts`.
 */
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunFileSystem, BunRuntime } from "@effect/platform-bun"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer)

BunRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
