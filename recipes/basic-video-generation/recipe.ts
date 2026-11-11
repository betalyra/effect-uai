/**
 * Generate a clip through the generic `VideoGenerator` service, one visible
 * step at a time: `submit` hands back a ref (plain data, persist it), `watch`
 * polls until the job settles, `toStream` reads the video through the
 * provider that produced it. `app.ts` picks the provider with `--model`.
 */
import { Effect, FileSystem, Schedule, Stream } from "effect"
import * as Job from "@effect-uai/core/Job"
import * as Retry from "@effect-uai/core/Retry"
import type { GeneratedVideo } from "@effect-uai/core/Video"
import * as VideoGenerator from "@effect-uai/core/VideoGenerator"

export const defaultPrompt =
  "A red fox trotting through fresh snow at golden hour, low tracking shot, soft breath clouds."

/** Start a generation. Returns as soon as the provider accepts it. */
export const start = (model: string, prompt: string) => VideoGenerator.submit({ model, prompt })

/**
 * Poll until the job settles, logging every state. The loop is ours, so is
 * its cadence. A failed poll leaves the job running, so a few retries are
 * safe here, where retrying `start` would pay for a second clip.
 */
export const settle = (ref: VideoGenerator.VideoJobRef) =>
  VideoGenerator.watch(ref, { pollInterval: "5 seconds", timeout: "15 minutes" }).pipe(
    Stream.tap((state) => Effect.logInfo(`job ${state._tag}`)),
    Job.result(ref),
    Retry.effect(Schedule.exponential("2 seconds").pipe(Schedule.upTo({ times: 3 }))),
  )

/** Stream a produced clip to disk. Nothing is fetched until this runs. */
export const save = (video: GeneratedVideo, path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    VideoGenerator.toStream(video.video).pipe(Stream.run(fs.sink(path))),
  )
