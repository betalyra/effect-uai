/**
 * Composition for the basic-music-generation recipe. `--provider` picks both
 * the default model in `recipe.ts` and the Layer from `_shared/model.ts`;
 * `--prompt-file` swaps in your own brief.
 *
 * Audio lands in `output/basic-music-generation/<timestamp>/`.
 */
import { Effect, FileSystem, Option, Stdio } from "effect"
import { flagValue, providerChoice } from "@effect-uai/recipe-kit/argv"
import { musicGeneratorLayer } from "../_shared/model.js"
import { runDir } from "@effect-uai/recipe-kit/output"
import { defaultModel, defaultPrompt, run } from "./recipe.js"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const fs = yield* FileSystem.FileSystem
  const argv = yield* stdio.args
  const provider = yield* providerChoice("elevenlabs", "google")
  const outDir = yield* runDir("basic-music-generation", argv)
  const model = defaultModel[provider]

  const prompt = yield* Option.match(flagValue("prompt-file", argv), {
    onNone: () => Effect.succeed(defaultPrompt),
    onSome: (file) => Effect.map(fs.readFileString(file), (s) => s.trim()),
  }).pipe(Effect.orDie)

  yield* Effect.logInfo(`generating with ${provider}`, {
    promptPreview: prompt.slice(0, 80),
    model,
  })

  const result = yield* run({ model, prompt }).pipe(
    Effect.provide(musicGeneratorLayer({ provider, model })),
  )

  yield* Effect.logInfo("generation complete", {
    bytes: result.primary.audio.bytes.length,
    format: result.primary.audio.format,
    provider: result.primary.provider,
    watermark: result.primary.watermark,
    songId: result.primary.songId,
    variants: result.variants.length,
  })

  yield* fs.makeDirectory(outDir, { recursive: true }).pipe(Effect.orDie)
  yield* fs.writeFile(`${outDir}/track.mp3`, result.primary.audio.bytes).pipe(Effect.orDie)
  yield* Effect.logInfo(`wrote ${outDir}/track.mp3`)
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
