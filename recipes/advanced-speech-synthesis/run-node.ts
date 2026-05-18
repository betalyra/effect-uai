/**
 * Node runner for the advanced-speech-synthesis recipe. Drives the
 * regional-pronunciation dialogue (multi-speaker + per-turn
 * pronunciation hints) under the ElevenLabs Layer.
 *
 *   `--mode dialogue`        — one-shot multi-speaker dialogue (default)
 *   `--mode dialogue-stream` — chunked multi-speaker dialogue
 *   `--mode both`            — runs both
 *
 * Only ElevenLabs ships the `MultiSpeakerTts` capability marker today
 * (Google Cloud TTS + Hume will join later). Swap providers here when
 * they do — the recipe code in `index.ts` doesn't change.
 *
 * Run with:
 *   `ELEVENLABS_API_KEY=... pnpm tsx recipes/advanced-speech-synthesis/run-node.ts`
 *   `ELEVENLABS_API_KEY=... pnpm tsx recipes/advanced-speech-synthesis/run-node.ts --mode dialogue-stream`
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Config, Effect, Layer, Logger, Match, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { layer as elevenlabsLayer } from "@effect-uai/elevenlabs/ElevenLabsSynthesizer"
import { synthesizeDialogueOneShot, synthesizeDialogueStreaming } from "./index.js"

type Mode = "dialogue" | "dialogue-stream" | "both"

const outDir = path.dirname(new URL(import.meta.url).pathname)

const usage = (): never => {
  console.error(
    `Usage: pnpm tsx recipes/advanced-speech-synthesis/run-node.ts [--mode dialogue|dialogue-stream|both]`,
  )
  process.exit(1)
}

const flagValue = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const parseMode = (argv: ReadonlyArray<string>): Mode =>
  Match.value(flagValue(argv, "--mode") ?? "dialogue").pipe(
    Match.whenOr("dialogue", "dialogue-stream", "both", (m): Mode => m),
    Match.orElse(usage),
  )

const writeOut = (name: string, bytes: Uint8Array) =>
  Effect.tryPromise(() => fs.writeFile(path.join(outDir, name), bytes))

const runDialogue = Effect.gen(function* () {
  const blob = yield* synthesizeDialogueOneShot()
  yield* Effect.logInfo("dialogue (one-shot) complete", {
    bytes: blob.bytes.length,
    format: blob.format,
  })
  yield* writeOut("out-dialogue.mp3", blob.bytes)
  yield* Effect.logInfo("wrote out-dialogue.mp3")
})

const runDialogueStream = Effect.gen(function* () {
  const result = yield* synthesizeDialogueStreaming()
  yield* Effect.logInfo("dialogue (streaming) complete", {
    chunkCount: result.chunkCount,
    bytes: result.bytes.length,
  })
  yield* writeOut("out-dialogue-stream.mp3", result.bytes)
  yield* Effect.logInfo("wrote out-dialogue-stream.mp3")
})

const mode = parseMode(process.argv)

const program = Match.value(mode).pipe(
  Match.when("dialogue", () => runDialogue),
  Match.when("dialogue-stream", () => runDialogueStream),
  Match.when("both", () =>
    Effect.gen(function* () {
      yield* runDialogue
      yield* runDialogueStream
    }),
  ),
  Match.exhaustive,
)

const providerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY")
    return elevenlabsLayer({ apiKey })
  }),
)

const mainLayer = Layer.mergeAll(
  providerLayer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  ),
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
