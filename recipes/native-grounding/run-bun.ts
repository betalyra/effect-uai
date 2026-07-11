/**
 * Bun runner for the native-grounding recipe.
 *
 *   GOOGLE_API_KEY=... bun recipes/native-grounding/run-bun.ts
 *   ANTHROPIC_API_KEY=... bun recipes/native-grounding/run-bun.ts --provider=anthropic
 *
 * Only the platform HttpClient and the runtime differ from `run-node.ts`;
 * composition and the loop are shared in `app.ts` / `recipe.ts`.
 */
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunRuntime } from "@effect/platform-bun"
import { appLayer, main } from "./app.js"

BunRuntime.runMain(
  main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(FetchHttpClient.layer)))),
)
