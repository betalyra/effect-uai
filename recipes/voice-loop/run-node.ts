/**
 * Node runner for the voice-loop recipe.
 *
 *   ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... \
 *     pnpm tsx recipes/voice-loop/run-node.ts
 *
 *   # All-Mistral stack (Voxtral STT/TTS + Mistral LLM):
 *   MISTRAL_API_KEY=... pnpm tsx recipes/voice-loop/run-node.ts --provider=mistral
 *
 * Compare with `run-bun.ts`: only the platform layers and the runMain call
 * differ. Provider selection, routes, the WS handler, and the pipeline body
 * live in `app.ts` and `index.ts`.
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

// NodeHttpClient.layerUndici streams SSE response bodies reliably; Node's
// built-in fetch has known issues with long-lived streaming bodies.
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
