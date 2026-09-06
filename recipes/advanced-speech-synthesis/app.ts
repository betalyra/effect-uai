/**
 * Composition for the advanced-speech-synthesis recipe. `--mode` picks
 * one-shot dialogue, the chunked variant, or both.
 *
 * Only ElevenLabs registers the `MultiSpeakerTts` marker today, so
 * `dialogueSynthesizerLayer` accepts only that provider: asking for another
 * one is a typed failure rather than a request the wire quietly flattens.
 * `recipe.ts` does not change when others join.
 *
 * Audio lands in `output/advanced-speech-synthesis/<timestamp>/`.
 */
import { Effect, FileSystem, Match, Stdio } from "effect"
import { choiceFlag } from "@effect-uai/recipe-kit/argv"
import { dialogueSynthesizerLayer } from "../_shared/model.js"
import { runDir } from "@effect-uai/recipe-kit/output"
import { MODEL, synthesizeDialogueOneShot, synthesizeDialogueStreaming } from "./recipe.js"

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
  const mode = yield* choiceFlag("mode", ["dialogue", "dialogue-stream", "both"], argv)
  const outDir = yield* runDir("advanced-speech-synthesis", argv)

  const oneShot = Effect.gen(function* () {
    const blob = yield* synthesizeDialogueOneShot()
    yield* Effect.logInfo("dialogue complete", { bytes: blob.bytes.length })
    yield* write(outDir, "dialogue.mp3", blob.bytes)
  })

  const streaming = Effect.gen(function* () {
    const streamed = yield* synthesizeDialogueStreaming()
    yield* Effect.logInfo("streamed dialogue complete", { bytes: streamed.bytes.length })
    yield* write(outDir, "dialogue-stream.mp3", streamed.bytes)
  })

  yield* Match.value(mode)
    .pipe(
      Match.when("dialogue", () => oneShot),
      Match.when("dialogue-stream", () => streaming),
      Match.orElse(() => Effect.andThen(oneShot, streaming)),
    )
    .pipe(Effect.provide(dialogueSynthesizerLayer({ provider: "elevenlabs", model: MODEL })))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
