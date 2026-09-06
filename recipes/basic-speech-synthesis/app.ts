/**
 * Composition for the basic-speech-synthesis recipe. `--provider` picks both
 * the request preset in `recipe.ts` and the Layer from `_shared/model.ts`;
 * `--mode` chooses one-shot, streaming, or both.
 *
 * Audio lands in `output/basic-speech-synthesis/<timestamp>/`, in whatever
 * container the provider natively returns.
 */
import { Effect, FileSystem, Match, Stdio } from "effect"
import { choiceFlag, providerChoice } from "@effect-uai/recipe-kit/argv"
import { speechSynthesizerLayer } from "../_shared/model.js"
import { runDir } from "@effect-uai/recipe-kit/output"
import { modelFor, outputExtFor, synthesizeOneShot, synthesizeStreaming } from "./recipe.js"

const write = (
  outDir: string,
  name: string,
  bytes: Uint8Array,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(outDir, { recursive: true })
    yield* fs.writeFile(`${outDir}/${name}`, bytes)
    yield* Effect.logInfo(`wrote ${outDir}/${name}`)
  }).pipe(Effect.orDie)

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const provider = yield* providerChoice("openai", "google", "elevenlabs", "inworld")
  const mode = yield* choiceFlag("mode", ["one-shot", "streaming", "both"], argv)
  const outDir = yield* runDir("basic-speech-synthesis", argv)
  const ext = outputExtFor(provider)
  const model = modelFor(provider)

  const oneShot = Effect.gen(function* () {
    const blob = yield* synthesizeOneShot(provider)
    yield* Effect.logInfo(`one-shot synthesis complete (${provider} ${model})`, {
      bytes: blob.bytes.length,
      format: blob.format,
    })
    yield* write(outDir, `one-shot.${ext}`, blob.bytes)
  })

  const streaming = Effect.gen(function* () {
    const streamed = yield* synthesizeStreaming(provider)
    yield* Effect.logInfo(`streaming synthesis complete (${provider} ${model})`, {
      chunkCount: streamed.chunkCount,
      bytes: streamed.bytes.length,
    })
    yield* write(outDir, `streaming.${ext}`, streamed.bytes)
  })

  yield* Match.value(mode)
    .pipe(
      Match.when("one-shot", () => oneShot),
      Match.when("streaming", () => streaming),
      Match.orElse(() => Effect.andThen(oneShot, streaming)),
    )
    .pipe(Effect.provide(speechSynthesizerLayer({ provider, model })))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
