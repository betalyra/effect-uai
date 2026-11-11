import { Bytes, Context, Effect, Stream } from "effect"
import type { Duration } from "effect"
import * as AiError from "../domain/AiError.js"
import type { AspectRatio, ProviderData } from "../domain/Media.js"
import type {
  GeneratedVideo,
  VideoBytesSource,
  VideoInput,
  VideoResolution,
  VideoSource,
} from "../domain/Video.js"
import { videoBytes } from "../domain/Video.js"
import * as Job from "../job/Job.js"

export type {
  GeneratedVideo,
  VideoInput,
  VideoMimeType,
  VideoResolution,
  VideoSource,
} from "../domain/Video.js"

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Cross-provider video-generation request. Trimmed to fields the majority
 * of providers honor structurally; provider extras (negative prompts,
 * camera control, prompt expansion, watermark toggles) live on each
 * provider's typed request, which extends this and narrows `model`.
 *
 * `prompt` is separate from `inputs` because every provider requires
 * exactly one text and none accepts several as equals. Image-to-video is
 * this request with a `FirstFrame` input.
 *
 * Audio is deliberately absent. Providers split three ways (a boolean, a
 * tri-state, always-on with no toggle) and two cannot generate it at all,
 * so there is nothing uniform to promise.
 */
export type CommonVideoGenerateRequest = {
  readonly prompt: string
  /** Model identifier. Each provider narrows. */
  readonly model: string
  /** Frames and references, ordered. Adapters map each to its wire role. */
  readonly inputs?: ReadonlyArray<VideoInput>
  /** Adapters encode to the wire (`"8s"`, `"5"`, `8`, or a frame count). */
  readonly duration?: Duration.Duration
  readonly aspectRatio?: AspectRatio
  readonly resolution?: VideoResolution
  /** Tuning hint: honored where the provider takes one, silent elsewhere. */
  readonly seed?: number
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Optional throughout: fal bills per second of output, Google per token. */
export type VideoUsage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  /** What the provider says it billed for, where it says so. */
  readonly billedDuration?: Duration.Duration
}

export type VideoResponse = {
  readonly videos: ReadonlyArray<GeneratedVideo>
  readonly usage: VideoUsage
  /** Response-level extras, keyed by provider name. */
  readonly providerData?: ProviderData
}

/** Handle to a running generation. Plain data; persist it and collect later. */
export type VideoJobRef = Job.JobRef<VideoResponse>

/** Decodes a persisted {@link VideoJobRef}. */
export const VideoJobRef = Job.refSchema<VideoResponse>()

/** Current state of a generation. See {@link Job.JobState}. */
export type VideoState = Job.JobState<VideoResponse>

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Video generation as an explicit background job. Generation runs for
 * seconds to minutes and costs per call, so the poll loop belongs to the
 * caller: `submit` hands back a ref and `status` is one fetch. The loops
 * are module-level and opt-in: {@link watch}, {@link collect},
 * {@link generate}.
 *
 * Every method here is exactly one wire call. Nothing retries or schedules.
 */
export type VideoGeneratorServiceShape<Req> = {
  /** Start a generation. Returns once the provider accepts the request. */
  readonly submit: (request: Req) => Effect.Effect<VideoJobRef, AiError.AiError>
  /** One status fetch. */
  readonly status: (ref: VideoJobRef) => Effect.Effect<VideoState, AiError.AiError>
  /** `Unsupported` where the provider has no cancel. */
  readonly cancel: (ref: VideoJobRef) => Effect.Effect<void, AiError.AiError>
  /**
   * Stream a video this provider produced. One GET for a `url` (with the
   * provider's auth where its file URLs need it), none for inline data.
   * URLs expire, so read before then.
   */
  readonly read: (video: VideoSource) => Stream.Stream<Uint8Array, AiError.AiError>
}

export type VideoGeneratorService = VideoGeneratorServiceShape<CommonVideoGenerateRequest>

export class VideoGenerator extends Context.Service<VideoGenerator, VideoGeneratorService>()(
  "@betalyra/effect-uai/VideoGenerator",
) {}

// ---------------------------------------------------------------------------
// Top-level accessors over the generic tag. Portable code uses these; they
// require only `VideoGenerator` in `R`.
// ---------------------------------------------------------------------------

/** Start a generation and return its ref. Does not wait for the video. */
export const submit = (
  request: CommonVideoGenerateRequest,
): Effect.Effect<VideoJobRef, AiError.AiError, VideoGenerator> =>
  Effect.flatMap(VideoGenerator, (s) => s.submit(request))

/** Current state of a generation. */
export const status = (
  ref: VideoJobRef,
): Effect.Effect<VideoState, AiError.AiError, VideoGenerator> =>
  Effect.flatMap(VideoGenerator, (s) => s.status(ref))

/** Cancel a running generation. */
export const cancel = (ref: VideoJobRef): Effect.Effect<void, AiError.AiError, VideoGenerator> =>
  Effect.flatMap(VideoGenerator, (s) => s.cancel(ref))

/**
 * A produced video as a byte stream, read by the provider in context, so
 * the provider that produced it. Nothing is fetched until this is run.
 */
export const toStream = (
  video: VideoSource,
): Stream.Stream<Uint8Array, AiError.AiError, VideoGenerator> =>
  Stream.unwrap(Effect.map(VideoGenerator, (s) => s.read(video)))

/** {@link toStream}, collected into memory. */
export const toBytes = (
  video: VideoSource,
): Effect.Effect<VideoBytesSource, AiError.AiError, VideoGenerator> =>
  Effect.map(Stream.runCollect(toStream(video)), (chunks) =>
    videoBytes(Bytes.concat(chunks), video.mimeType ?? "video/mp4"),
  )

// The loops. Cadence and the overall cap are arguments, see `Job.JobConfig`.

/** Every polled state, ending with the settled one (queue position, for a UI). */
export const watch = (
  ref: VideoJobRef,
  config?: Job.JobConfig,
): Stream.Stream<VideoState, AiError.AiError, VideoGenerator> =>
  Stream.unwrap(Effect.map(VideoGenerator, (s) => Job.watch(s.status, ref, config)))

/** Poll until the generation settles, then return the videos. Leaves the job running if interrupted. */
export const collect = (
  ref: VideoJobRef,
  config?: Job.JobConfig,
): Effect.Effect<VideoResponse, AiError.AiError, VideoGenerator> =>
  Effect.flatMap(VideoGenerator, (s) => Job.collect(s.status, ref, config))

/**
 * Submit, then {@link collect}, cancelling the provider's job if interrupted.
 * The ref never leaves this call, so use `submit` + `collect` to persist it.
 */
export const generate = (
  request: CommonVideoGenerateRequest,
  config?: Job.JobConfig,
): Effect.Effect<VideoResponse, AiError.AiError, VideoGenerator> =>
  Effect.flatMap(VideoGenerator, (s) =>
    Job.run({ submit: s.submit(request), poll: s.status, cancel: s.cancel }, config),
  )
