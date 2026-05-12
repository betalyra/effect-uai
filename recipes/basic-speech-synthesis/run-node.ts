/**
 * Node-specific runner for the basic-speech-synthesis recipe. Wires up
 * the real OpenAI TTS provider, runs both the one-shot and chunked-stream
 * variants, and writes the resulting audio files to disk for playback.
 *
 * Uses `node:fs/promises` and `node:path`, so it's Node/Bun/Deno-on-Node-compat
 * only. For other runtimes, write a sibling `run-bun.ts` / `run-deno.ts`.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-speech-synthesis/run-node.ts`
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Config, Effect, Layer, Logger, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as openAILayer } from "@effect-uai/openai-speech/OpenAISynthesizer"
import { synthesizeOneShot, synthesizeStreaming } from "./index.js"

const outDir = path.dirname(new URL(import.meta.url).pathname)

const program = Effect.gen(function* () {
  const oneShot = yield* synthesizeOneShot
  yield* Effect.logInfo("one-shot synthesis complete", {
    bytes: oneShot.bytes.length,
    format: oneShot.format,
  })
  yield* Effect.tryPromise(() =>
    fs.writeFile(path.join(outDir, "out-oneshot.mp3"), oneShot.bytes),
  )

  const streamed = yield* synthesizeStreaming
  yield* Effect.logInfo("streaming synthesis complete", {
    chunkCount: streamed.chunkCount,
    bytes: streamed.bytes.length,
  })
  yield* Effect.tryPromise(() =>
    fs.writeFile(path.join(outDir, "out-streaming.mp3"), streamed.bytes),
  )

  yield* Effect.logInfo("wrote out-oneshot.mp3 and out-streaming.mp3 alongside this recipe")
})

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return openAILayer({ apiKey })
  }),
)

const mainLayer = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(
    Effect.provide(mainLayer),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
