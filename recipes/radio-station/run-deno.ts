/**
 * Deno runner for the radio-station recipe.
 *
 *   OPENAI_API_KEY=... ELEVENLABS_API_KEY=... \
 *     deno run --allow-all recipes/radio-station/run-deno.ts
 *
 *   # Switch provider via argv:
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/radio-station/run-deno.ts --provider=google
 *
 * Uses `@effect/platform-node` through Deno's Node-compat layer.
 * `recipes/deno.json` pins `nodeModulesDir: "manual"` so Deno resolves
 * bare specifiers against the pnpm-installed `node_modules`. Once
 * `@effect/platform-deno` ships, the platform imports can be swapped
 * over without touching `recipe.ts` or `app.ts`.
 */
import { createServer } from "node:http"
import { Config, Effect, Layer } from "effect"
import * as HttpServer from "effect/unstable/http/HttpServer"
import {
  NodeFileSystem,
  NodeHttpClient,
  NodeHttpServer,
  NodePath,
  NodeRuntime,
} from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(
  Layer.unwrap(
    Effect.gen(function* () {
      const port = yield* Config.port("PORT").pipe(Config.withDefault(3000))
      return NodeHttpServer.layer(() => createServer(), {
        port,
        gracefulShutdownTimeout: "1 second",
      })
    }),
  ).pipe(HttpServer.withLogAddress),
  NodeFileSystem.layer,
  NodePath.layer,
  NodeHttpClient.layerUndici,
)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
