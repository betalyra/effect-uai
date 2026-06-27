/**
 * Bun runner for the voice-loop recipe.
 *
 *   ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... bun recipes/voice-loop/run-bun.ts
 *
 *   # All-Mistral stack (Voxtral STT/TTS + Mistral LLM):
 *   MISTRAL_API_KEY=... bun recipes/voice-loop/run-bun.ts --provider=mistral
 *
 * Everything not in this file lives in `app.ts` (composition + routes + WS
 * handler) and `index.ts` (the pipeline). This file only attaches the Bun
 * platform layers and starts the Bun runtime — compare with `run-node.ts`.
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
