/**
 * Composition for the basic-video-generation recipe. `--model provider:model`
 * picks the provider (default Gemini Omni); `--prompt-file` swaps in your own
 * brief. The job's ref is written to `ref.json` before the first poll, so an
 * interrupted run resumes with `--ref <run dir>/ref.json` instead of paying
 * for a second clip.
 *
 * Clips land in `output/basic-video-generation/<timestamp>/`.
 */
import { Effect, FileSystem, Option, Schema, Stdio } from "effect"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { runDir } from "@effect-uai/recipe-kit/output"
import * as VideoGenerator from "@effect-uai/core/VideoGenerator"
import { parseModelSpec, videoGeneratorLayer } from "../_shared/model.js"
import { defaultPrompt, save, settle, start } from "./recipe.js"

const RefJson = Schema.fromJsonString(VideoGenerator.VideoJobRef)

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const fs = yield* FileSystem.FileSystem
  const argv = yield* stdio.args
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => "gemini-omni-1.2-flash"),
    "google",
  )
  const outDir = yield* runDir("basic-video-generation", argv)
  yield* fs.makeDirectory(outDir, { recursive: true })

  const prompt = yield* Option.match(flagValue("prompt-file", argv), {
    onNone: () => Effect.succeed(defaultPrompt),
    onSome: (file) => Effect.map(fs.readFileString(file), (s) => s.trim()),
  })

  const program = Effect.gen(function* () {
    const ref = yield* Option.match(flagValue("ref", argv), {
      onSome: (file) =>
        Effect.tap(Effect.flatMap(fs.readFileString(file), Schema.decodeEffect(RefJson)), (r) =>
          Effect.logInfo(`resuming ${r.provider} job ${r.id}`),
        ),
      onNone: () =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`submitting to ${spec.provider} ${spec.model}`)
          const r = yield* start(spec.model, prompt)
          // Persist before the first poll: a crash from here on loses nothing.
          yield* fs.writeFileString(`${outDir}/ref.json`, yield* Schema.encodeEffect(RefJson)(r))
          return r
        }),
    })

    const result = yield* settle(ref)
    yield* Effect.logInfo("settled", { usage: result.usage, videos: result.videos.length })
    yield* Effect.forEach(result.videos, (video, i) =>
      save(video, `${outDir}/clip-${i}.mp4`).pipe(
        Effect.andThen(Effect.logInfo(`wrote ${outDir}/clip-${i}.mp4`)),
      ),
    )
  })

  yield* program.pipe(Effect.provide(videoGeneratorLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
