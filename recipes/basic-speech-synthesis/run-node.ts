/**
 * Node-specific runner for the basic-speech-synthesis recipe. Picks a
 * provider Layer based on `--provider <name>` (default `openai`) and
 * picks a synthesis mode based on `--mode <one-shot|streaming|both>`
 * (default `one-shot`).
 *
 * Run with:
 *   `OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-speech-synthesis/run-node.ts`
 *   `OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-speech-synthesis/run-node.ts --mode streaming`
 *   `GOOGLE_API_KEY=...   pnpm tsx recipes/basic-speech-synthesis/run-node.ts --provider gemini --mode both`
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Config, Effect, Layer, Logger, Match, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as elevenlabsLayer } from "@effect-uai/elevenlabs/ElevenLabsSynthesizer"
import { layer as geminiLayer } from "@effect-uai/google/GeminiSynthesizer"
import { layer as openaiLayer } from "@effect-uai/openai-speech/OpenAISynthesizer"
import { outputExtFor, synthesizeOneShot, synthesizeStreaming, type Provider } from "./index.js"

type Mode = "one-shot" | "streaming" | "both"

const outDir = path.dirname(new URL(import.meta.url).pathname)

const usage = (): never => {
  console.error(
    `Usage: pnpm tsx recipes/basic-speech-synthesis/run-node.ts [--provider openai|gemini|elevenlabs] [--mode one-shot|streaming|both]`,
  )
  process.exit(1)
}

const flagValue = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const parseProvider = (argv: ReadonlyArray<string>): Provider =>
  Match.value(flagValue(argv, "--provider") ?? "openai").pipe(
    Match.whenOr("openai", "gemini", "elevenlabs", (p): Provider => p),
    Match.orElse(usage),
  )

const parseMode = (argv: ReadonlyArray<string>): Mode =>
  Match.value(flagValue(argv, "--mode") ?? "one-shot").pipe(
    Match.whenOr("one-shot", "streaming", "both", (m): Mode => m),
    Match.orElse(usage),
  )

const layerFor = Match.type<Provider>().pipe(
  Match.when("openai", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("OPENAI_API_KEY")
        return openaiLayer({ apiKey })
      }),
    ),
  ),
  Match.when("gemini", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
        return geminiLayer({ apiKey })
      }),
    ),
  ),
  Match.when("elevenlabs", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY")
        return elevenlabsLayer({ apiKey })
      }),
    ),
  ),
  Match.exhaustive,
)

const provider = parseProvider(process.argv)
const mode = parseMode(process.argv)
const ext = outputExtFor(provider)

const runOneShot = Effect.gen(function* () {
  const oneShot = yield* synthesizeOneShot(provider)
  yield* Effect.logInfo(`one-shot synthesis complete (${provider})`, {
    bytes: oneShot.bytes.length,
    format: oneShot.format,
  })
  yield* Effect.tryPromise(() =>
    fs.writeFile(path.join(outDir, `out-oneshot.${ext}`), oneShot.bytes),
  )
  yield* Effect.logInfo(`wrote out-oneshot.${ext}`)
})

const runStreaming = Effect.gen(function* () {
  const streamed = yield* synthesizeStreaming(provider)
  yield* Effect.logInfo(`streaming synthesis complete (${provider})`, {
    chunkCount: streamed.chunkCount,
    bytes: streamed.bytes.length,
  })
  yield* Effect.tryPromise(() =>
    fs.writeFile(path.join(outDir, `out-streaming.${ext}`), streamed.bytes),
  )
  yield* Effect.logInfo(`wrote out-streaming.${ext}`)
})

const program = Match.value(mode).pipe(
  Match.when("one-shot", () => runOneShot),
  Match.when("streaming", () => runStreaming),
  Match.when("both", () =>
    Effect.gen(function* () {
      yield* runOneShot
      yield* runStreaming
    }),
  ),
  Match.exhaustive,
)

const mainLayer = Layer.mergeAll(
  layerFor(provider).pipe(Layer.provide(FetchHttpClient.layer)),
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
