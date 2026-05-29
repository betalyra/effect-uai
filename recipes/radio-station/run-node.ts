/**
 * Node runner for the radio-station recipe.
 *
 *   OPENAI_API_KEY=... ELEVENLABS_API_KEY=... \
 *     pnpm tsx recipes/radio-station/run-node.ts
 *
 *   # Switch provider via argv:
 *   GOOGLE_API_KEY=... pnpm tsx recipes/radio-station/run-node.ts --provider=google
 *
 * Compare with `run-bun.ts`: only the three platform layers and the
 * runMain call differ. Everything else (provider selection, config,
 * routes, WS handler, the recipe body) is in `app.ts` and `recipe.ts`.
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

// NodeHttpClient.layerUndici uses Undici under the hood, which handles
// SSE-streaming response bodies reliably. Node's built-in `fetch` has
// known issues with long-lived streaming bodies that surface as
// `Unavailable` errors from providers that stream their responses.
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
