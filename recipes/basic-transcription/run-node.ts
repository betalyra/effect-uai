/**
 * Node-specific runner for the basic-transcription recipe. Picks a
 * provider Layer based on `--provider <name>` (default `openai`) and
 * transcribes the given audio file.
 *
 * The OpenAI verbose (`whisper-1` + word timestamps) variant only runs
 * when `--provider openai` is selected — Gemini's transcription has no
 * structured per-word timing.
 *
 * Run with:
 *   `OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-transcription/run-node.ts <audio>`
 *   `GOOGLE_API_KEY=...   pnpm tsx recipes/basic-transcription/run-node.ts --provider gemini <audio>`
 *
 * Audio formats: m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm, flac.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Config, Effect, Layer, Logger, Match, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import type { AudioMimeType, AudioSource } from "@effect-uai/core/Audio"
import { layer as elevenlabsLayer } from "@effect-uai/elevenlabs/ElevenLabsTranscriber"
import { layer as geminiLayer } from "@effect-uai/google/GeminiTranscriber"
import { layer as inworldLayer } from "@effect-uai/inworld/InworldTranscriber"
import { layer as openaiLayer } from "@effect-uai/openai/OpenAITranscriber"
import { transcribeFast, transcribeVerbose, type Provider } from "./index.js"

const mimeForExt: (ext: string) => AudioMimeType = Match.type<string>().pipe(
  Match.whenOr(".mp3", ".mpga", ".mpeg", (): AudioMimeType => "audio/mpeg"),
  Match.when(".wav", (): AudioMimeType => "audio/wav"),
  Match.whenOr(".ogg", ".oga", (): AudioMimeType => "audio/ogg"),
  Match.whenOr(".m4a", ".mp4", (): AudioMimeType => "audio/mp4"),
  Match.when(".webm", (): AudioMimeType => "audio/webm"),
  Match.when(".flac", (): AudioMimeType => "audio/flac"),
  Match.orElse((): AudioMimeType => "application/octet-stream"),
)

const usage = (): never => {
  console.error(
    `Usage: pnpm tsx recipes/basic-transcription/run-node.ts [--provider openai|gemini|elevenlabs|inworld] <audio-file>`,
  )
  process.exit(1)
}

const flagValue = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const parseProvider = (argv: ReadonlyArray<string>): Provider =>
  Match.value(flagValue(argv, "--provider") ?? "openai").pipe(
    Match.whenOr("openai", "gemini", "elevenlabs", "inworld", (p): Provider => p),
    Match.orElse(usage),
  )

const parseAudioPath = (argv: ReadonlyArray<string>): string => {
  // First positional that isn't part of a `--flag value` pair.
  const skip = new Set<number>()
  argv.forEach((arg, i) => {
    if (arg.startsWith("--")) {
      skip.add(i)
      skip.add(i + 1)
    }
  })
  const positional = argv.find((_, i) => !skip.has(i))
  return positional ?? usage()
}

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
  Match.when("inworld", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("INWORLD_API_KEY")
        return inworldLayer({ apiKey })
      }),
    ),
  ),
  Match.exhaustive,
)

const provider = parseProvider(process.argv.slice(2))
const audioPath = parseAudioPath(process.argv.slice(2))

const program = Effect.gen(function* () {
  const bytes = yield* Effect.tryPromise(() => fs.readFile(audioPath))
  const audio: AudioSource = {
    _tag: "bytes",
    bytes: new Uint8Array(bytes),
    mimeType: mimeForExt(path.extname(audioPath).toLowerCase()),
  }

  const fast = yield* transcribeFast(provider, audio)
  yield* Effect.logInfo(`fast transcription (${provider})`, { text: fast.text })

  if (provider === "openai") {
    const verbose = yield* transcribeVerbose(audio)
    yield* Effect.logInfo("verbose (whisper-1, openai only)", {
      text: verbose.text,
      languageCode: verbose.languageCode,
      durationSeconds: verbose.durationSeconds,
      wordCount: verbose.words?.length ?? 0,
      firstWords: verbose.words?.slice(0, 5),
    })
  }
})

const mainLayer = Layer.mergeAll(
  layerFor(provider).pipe(
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
