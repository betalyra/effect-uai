/**
 * Generate a clip through the generic `VideoGenerator` service, one visible
 * step at a time: `submit` hands back a ref (plain data, persist it), `watch`
 * polls until the job settles, `toStream` reads the video through the
 * provider that produced it. `app.ts` picks the provider with `--model`.
 */
import { Effect, FileSystem, Match, Option, Stream } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import * as Job from "@effect-uai/core/Job"
import type { GeneratedVideo } from "@effect-uai/core/Video"
import * as VideoGenerator from "@effect-uai/core/VideoGenerator"

export const defaultPrompt =
  "A red fox trotting through fresh snow at golden hour, low tracking shot, soft breath clouds."

/** Start a generation. Returns as soon as the provider accepts it. */
export const start = (model: string, prompt: string) => VideoGenerator.submit({ model, prompt })

/** Poll until the job settles, logging every state. The loop is ours, so is its cadence. */
export const settle = (ref: VideoGenerator.VideoJobRef) =>
  VideoGenerator.watch(ref, { pollInterval: "5 seconds", timeout: "15 minutes" }).pipe(
    Stream.tap((state) => Effect.logInfo(`job ${state._tag}`)),
    Stream.runLast,
    Effect.flatMap((last) =>
      Match.value(Option.getOrElse(last, () => Job.JobState.Running())).pipe(
        Match.tag("Succeeded", (s) => Effect.succeed(s.result)),
        Match.tag("Failed", (s) => Effect.fail(failure(ref, s.reason ?? "job failed", s.raw))),
        Match.orElse((s) => Effect.fail(failure(ref, "job did not settle", s))),
      ),
    ),
  )

const failure = (ref: VideoGenerator.VideoJobRef, message: string, raw: unknown) =>
  new AiError.GenerationFailed({ provider: ref.provider, message, raw })

/** Stream a produced clip to disk. Nothing is fetched until this runs. */
export const save = (video: GeneratedVideo, path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    VideoGenerator.toStream(video.video).pipe(Stream.run(fs.sink(path))),
  )
