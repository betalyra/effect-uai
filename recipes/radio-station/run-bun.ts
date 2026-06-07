/**
 * Bun runner for the radio-station recipe.
 *
 *   OPENAI_API_KEY=... ELEVENLABS_API_KEY=... \
 *     bun recipes/radio-station/run-bun.ts
 *
 *   # Switch provider via argv:
 *   GOOGLE_API_KEY=... bun recipes/radio-station/run-bun.ts --provider=google
 *
 * Everything not in this file is in `app.ts` (composition) and the
 * per-concern modules (`recipe.ts`, `server.ts`, `bundle.ts`). This
 * file's only job is to attach the Bun platform layers and start the
 * Bun runtime. Compare side-by-side with `run-node.ts` to see exactly
 * what's runtime-specific.
 */
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as HttpServer from "effect/unstable/http/HttpServer"
import { BunFileSystem, BunHttpServer, BunPath, BunRuntime } from "@effect/platform-bun"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(
  Layer.unwrap(
    Effect.gen(function* () {
      const port = yield* Config.port("PORT").pipe(Config.withDefault(3000))
      return BunHttpServer.layer({ port })
    }),
  ).pipe(HttpServer.withLogAddress),
  BunFileSystem.layer,
  BunPath.layer,
  FetchHttpClient.layer,
)

BunRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
