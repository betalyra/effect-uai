/**
 * Deno runner for the voice-loop recipe.
 *
 *   ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... \
 *     deno run --allow-all recipes/voice-loop/run-deno.ts
 *
 *   # All-Mistral stack (Voxtral STT/TTS + Mistral LLM):
 *   MISTRAL_API_KEY=... deno run --allow-all recipes/voice-loop/run-deno.ts --provider=mistral
 *
 * Uses `@effect/platform-node` through Deno's Node-compat layer.
 * `recipes/deno.json` pins `nodeModulesDir: "manual"` so Deno resolves bare
 * specifiers against the pnpm-installed `node_modules`. Once
 * `@effect/platform-deno` ships, the platform imports can be swapped over
 * without touching `app.ts` or `index.ts`.
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
