/**
 * Node-specific runner for the basic-transcription recipe. Reads an
 * audio file from disk, transcribes it twice (gpt-4o-transcribe for
 * speed; whisper-1 with word timestamps for richer output), and prints
 * both results.
 *
 * Run with:
 *   `OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-transcription/run-node.ts <audio-file>`
 *
 * Audio files supported by OpenAI: m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Config, Effect, Layer, Logger, Match, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { AudioMimeType, AudioSource } from "@effect-uai/core/Audio"
import { layer as openAILayer } from "@effect-uai/openai-speech/OpenAITranscriber"
import { transcribeGpt4o, transcribeWhisperVerbose } from "./index.js"

const mimeForExt: (ext: string) => AudioMimeType = Match.type<string>().pipe(
  Match.whenOr(".mp3", ".mpga", ".mpeg", (): AudioMimeType => "audio/mpeg"),
  Match.when(".wav", (): AudioMimeType => "audio/wav"),
  Match.whenOr(".ogg", ".oga", (): AudioMimeType => "audio/ogg"),
  Match.whenOr(".m4a", ".mp4", (): AudioMimeType => "audio/mp4"),
  Match.when(".webm", (): AudioMimeType => "audio/webm"),
  Match.when(".flac", (): AudioMimeType => "audio/flac"),
  Match.orElse((): AudioMimeType => "application/octet-stream"),
)

const audioPath = process.argv[2]
if (audioPath === undefined) {
  console.error("Usage: pnpm tsx recipes/basic-transcription/run-node.ts <audio-file>")
  process.exit(1)
}

const program = Effect.gen(function* () {
  const bytes = yield* Effect.tryPromise(() => fs.readFile(audioPath))
  const audio: AudioSource = {
    _tag: "bytes",
    bytes: new Uint8Array(bytes),
    mimeType: mimeForExt(path.extname(audioPath).toLowerCase()),
  }

  const fast = yield* transcribeGpt4o(audio)
  yield* Effect.logInfo("gpt-4o-transcribe", { text: fast.text })

  const verbose = yield* transcribeWhisperVerbose(audio)
  yield* Effect.logInfo("whisper-1 (verbose)", {
    text: verbose.text,
    languageCode: verbose.languageCode,
    durationSeconds: verbose.durationSeconds,
    wordCount: verbose.words?.length ?? 0,
    firstWords: verbose.words?.slice(0, 5),
  })
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
