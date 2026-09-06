/**
 * Composition for the basic-transcription recipe. `--provider` picks both the
 * fast model in `recipe.ts` and the Layer from `_shared/model.ts`; the audio
 * file is the one positional argument.
 *
 * Audio formats: m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm, flac.
 */
import { Data, Effect, FileSystem, Match, Option, Path, Stdio } from "effect"
import type { AudioMimeType, AudioSource } from "@effect-uai/core/Audio"
import { providerChoice } from "@effect-uai/recipe-kit/argv"
import { transcriberLayer } from "../_shared/model.js"
import { modelFor, transcribeFast, transcribeVerbose } from "./recipe.js"

/** No audio file was named, so there is nothing to transcribe. */
class MissingAudio extends Data.TaggedError("MissingAudio")<{
  readonly usage: string
}> {}

const mimeForExt: (ext: string) => AudioMimeType = Match.type<string>().pipe(
  Match.whenOr(".mp3", ".mpga", ".mpeg", (): AudioMimeType => "audio/mpeg"),
  Match.when(".wav", (): AudioMimeType => "audio/wav"),
  Match.whenOr(".ogg", ".oga", (): AudioMimeType => "audio/ogg"),
  Match.whenOr(".m4a", ".mp4", (): AudioMimeType => "audio/mp4"),
  Match.when(".webm", (): AudioMimeType => "audio/webm"),
  Match.when(".flac", (): AudioMimeType => "audio/flac"),
  Match.orElse((): AudioMimeType => "application/octet-stream"),
)

/** The first token that is neither a `--flag` nor a flag's value. */
const audioPath = (argv: ReadonlyArray<string>): Option.Option<string> => {
  const skip = new Set<number>()
  argv.forEach((arg, i) => {
    if (arg.startsWith("--") && !arg.includes("=")) {
      skip.add(i)
      skip.add(i + 1)
    } else if (arg.startsWith("--")) {
      skip.add(i)
    }
  })
  return Option.fromNullishOr(argv.find((_, i) => !skip.has(i)))
}

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const argv = yield* stdio.args
  const provider = yield* providerChoice("openai", "elevenlabs", "inworld")

  const file = yield* Option.match(audioPath(argv), {
    onNone: () =>
      Effect.fail(
        new MissingAudio({
          usage: "run.ts [--provider openai|elevenlabs|inworld] <audio-file>",
        }),
      ),
    onSome: Effect.succeed,
  })

  const bytes = yield* fs.readFile(file)
  const audio: AudioSource = {
    _tag: "bytes",
    bytes,
    mimeType: mimeForExt(path.extname(file).toLowerCase()),
  }

  yield* Effect.gen(function* () {
    const fast = yield* transcribeFast(provider, audio)
    yield* Effect.logInfo(`fast transcription (${provider})`, { text: fast.text })

    // Per-word timing is not something every provider returns, so the
    // verbose pass only runs where it means something.
    if (provider === "openai") {
      const verbose = yield* transcribeVerbose(audio)
      yield* Effect.logInfo("verbose (whisper-1, openai only)", {
        text: verbose.text,
        languageCode: verbose.languageCode,
        duration: verbose.duration,
        wordCount: verbose.words?.length ?? 0,
        firstWords: verbose.words?.slice(0, 5),
      })
    }
  }).pipe(Effect.provide(transcriberLayer({ provider, model: modelFor(provider) })))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
