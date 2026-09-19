import { Context, Duration, Effect, Layer, Match, Option, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Job from "@effect-uai/core/Job"
import type { GeneratedVideo } from "@effect-uai/core/Video"
import { VideoInput, videoBase64, videoUrl } from "@effect-uai/core/Video"
import type {
  CommonVideoGenerateRequest,
  VideoGeneratorService,
  VideoGeneratorServiceShape,
  VideoJobRef,
  VideoResponse,
  VideoState,
} from "@effect-uai/core/VideoGenerator"
import { VideoGenerator } from "@effect-uai/core/VideoGenerator"
import { PROVIDER, dataUri, referenceUrl } from "./codec.js"
import type { FalVideoModel } from "./models.js"
import * as Queue from "./queue.js"
import type { VideoWire } from "./video.js"
import { durationField, resolutionField, wireOf } from "./video.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FalVideoGenerateRequest = Omit<CommonVideoGenerateRequest, "model"> & {
  /** The endpoint, which is also the model. Image-to-video is its own id. */
  readonly model: FalVideoModel
  /**
   * Wire fields one endpoint family takes and the next does not:
   * `negative_prompt`, `generate_audio`, `camera_motion`, `sync_mode`,
   * `num_frames`. Merged last, so it also overrides anything derived from
   * the portable fields. Snake case, as the wire spells it.
   */
  readonly wire?: Record<string, unknown>
}

/** Per-video extras on `GeneratedVideo.providerData.fal`. */
const VideoData = Schema.Struct({
  fileName: Schema.optional(Schema.String),
  fileSize: Schema.optional(Schema.Number),
  numFrames: Schema.optional(Schema.Number),
})
export type FalVideoData = typeof VideoData.Type

/** Response-level extras on `VideoResponse.providerData.fal`. */
const ResponseData = Schema.Struct({
  /** The seed a request resolved to. Send it back for the same clip. */
  seed: Schema.optional(Schema.Number),
  timings: Schema.optional(Schema.Unknown),
  /** A rewritten prompt, under the name the endpoint reported it. */
  actualPrompt: Schema.optional(Schema.String),
  expandedPrompt: Schema.optional(Schema.String),
})
export type FalResponseData = typeof ResponseData.Type

export type FalVideoGeneratorService = VideoGeneratorServiceShape<FalVideoGenerateRequest>

/**
 * Provider-typed service tag. Yield this for the per-endpoint `wire`
 * passthrough; yield the generic `VideoGenerator` tag for provider-portable
 * code. Both are registered by {@link layer}.
 */
export class FalVideoGenerator extends Context.Service<
  FalVideoGenerator,
  FalVideoGeneratorService
>()("@betalyra/effect-uai/providers/fal/FalVideoGenerator") {}

export type Config = Queue.Config

// ---------------------------------------------------------------------------
// Codec - request
// ---------------------------------------------------------------------------

/**
 * The two frame roles have a field per family; a reference image does not,
 * so it stays explicit rather than guessed at.
 */
const fieldFor = (wire: VideoWire): ((input: VideoInput) => Option.Option<string>) =>
  VideoInput.$match({
    FirstFrame: () => wire.firstFrame,
    LastFrame: () => wire.lastFrame,
    ReferenceImage: () => Option.none(),
  })

const frameField =
  (wire: VideoWire, endpoint: string) =>
  (input: VideoInput): Effect.Effect<readonly [string, string], AiError.AiError> =>
    Option.match(fieldFor(wire)(input), {
      onNone: () =>
        Effect.fail(
          new AiError.Unsupported({
            provider: PROVIDER,
            capability: input._tag,
            reason: `\`${endpoint}\` takes no ${input._tag}. Pass it through \`wire\` if the endpoint documents a field for it.`,
          }),
        ),
      onSome: (field) => Effect.succeed([field, referenceUrl(input.image)] as const),
    })

const buildBody = (
  request: FalVideoGenerateRequest,
): Effect.Effect<Record<string, unknown>, AiError.AiError> =>
  Effect.gen(function* () {
    const wire = wireOf(request.model)
    const frames = yield* Effect.forEach(request.inputs ?? [], frameField(wire, request.model))
    const duration = yield* durationField(wire, request.model, request.duration)
    const resolution = yield* resolutionField(wire, request.model, request.resolution)
    return {
      prompt: request.prompt,
      ...duration,
      ...resolution,
      ...(request.aspectRatio !== undefined && { aspect_ratio: request.aspectRatio }),
      ...(request.seed !== undefined && { seed: request.seed }),
      ...Object.fromEntries(frames),
      ...request.wire,
    }
  })

// ---------------------------------------------------------------------------
// Codec - response
//
// Only `url` is dependable: fal's per-model schemas disagree on every other
// field, one declaring `width` required where the next sends `null`.
// ---------------------------------------------------------------------------

const VideoFile = Schema.Struct({
  url: Schema.String,
  content_type: Schema.optional(Schema.NullOr(Schema.String)),
  file_name: Schema.optional(Schema.NullOr(Schema.String)),
  file_size: Schema.optional(Schema.NullOr(Schema.Number)),
  width: Schema.optional(Schema.NullOr(Schema.Number)),
  height: Schema.optional(Schema.NullOr(Schema.Number)),
  fps: Schema.optional(Schema.NullOr(Schema.Number)),
  duration: Schema.optional(Schema.NullOr(Schema.Number)),
  num_frames: Schema.optional(Schema.NullOr(Schema.Number)),
})
type VideoFile = typeof VideoFile.Type

const Wire = Schema.Struct({
  video: Schema.optional(Schema.NullOr(VideoFile)),
  videos: Schema.optional(Schema.NullOr(Schema.Array(VideoFile))),
  seed: Schema.optional(Schema.NullOr(Schema.Number)),
  timings: Schema.optional(Schema.NullOr(Schema.Unknown)),
  actual_prompt: Schema.optional(Schema.NullOr(Schema.String)),
  expanded_prompt: Schema.optional(Schema.NullOr(Schema.String)),
})
type Wire = typeof Wire.Type

const decodeWire = Schema.decodeUnknownEffect(Schema.fromJsonString(Wire))

const isSet = (extras: object): boolean => Object.keys(extras).length > 0

const videoExtras = (file: VideoFile): FalVideoData => ({
  ...(file.file_name != null && { fileName: file.file_name }),
  ...(file.file_size != null && { fileSize: file.file_size }),
  ...(file.num_frames != null && { numFrames: file.num_frames }),
})

/** No fal video model documents a watermark, so none is claimed. */
const generatedVideo = (file: VideoFile): GeneratedVideo => {
  const extras = videoExtras(file)
  return {
    video: Option.match(dataUri(file.url), {
      onNone: () => videoUrl(file.url, file.content_type ?? undefined),
      onSome: ([mimeType, base64]) => videoBase64(base64, mimeType),
    }),
    ...(file.duration != null && { duration: Duration.seconds(file.duration) }),
    ...(file.width != null && { width: file.width }),
    ...(file.height != null && { height: file.height }),
    ...(file.fps != null && { fps: file.fps }),
    ...(isSet(extras) && { providerData: { fal: extras } }),
  }
}

/** A few endpoints return `video` singular; the rest return `videos`. */
const filesOf = (wire: Wire): ReadonlyArray<VideoFile> => [
  ...(wire.videos ?? []),
  ...(wire.video == null ? [] : [wire.video]),
]

// fal bills per second of output rather than per token, so there is no usage
// to report.
const toResponse = (wire: Wire): VideoResponse => {
  const extras: FalResponseData = {
    ...(wire.seed != null && { seed: wire.seed }),
    ...(wire.timings != null && { timings: wire.timings }),
    ...(wire.actual_prompt != null && { actualPrompt: wire.actual_prompt }),
    ...(wire.expanded_prompt != null && { expandedPrompt: wire.expanded_prompt }),
  }
  return {
    videos: filesOf(wire).map(generatedVideo),
    usage: {},
    ...(isSet(extras) && { providerData: { fal: extras } }),
  }
}

/** An empty output settles the job as failed; it is not a transport error. */
const toState = (body: string): Effect.Effect<VideoState, AiError.AiError> =>
  decodeWire(body).pipe(
    Effect.mapError(
      () =>
        new AiError.GenerationFailed({
          provider: PROVIDER,
          message: "fal returned a body with no readable video field.",
          raw: body,
        }),
    ),
    Effect.map((wire) =>
      filesOf(wire).length === 0
        ? Job.JobState.Failed({ reason: "fal returned no video.", raw: body })
        : Job.JobState.Succeeded({ result: toResponse(wire) }),
    ),
  )

// ---------------------------------------------------------------------------
// Reading the extras
// ---------------------------------------------------------------------------

const decodeVideoData = Schema.decodeUnknownOption(Schema.Struct({ fal: VideoData }))
const decodeResponseData = Schema.decodeUnknownOption(Schema.Struct({ fal: ResponseData }))

/**
 * File metadata for one video, where the endpoint reported it.
 * `providerData` is a shared slot, so this reads only the `fal` key and
 * returns `None` for a video from another provider.
 */
export const videoDataOf = (video: GeneratedVideo): Option.Option<FalVideoData> =>
  Option.map(decodeVideoData(video.providerData), (d) => d.fal)

/** The seed a request resolved to, plus timings and any prompt rewrite. */
export const responseDataOf = (response: VideoResponse): Option.Option<FalResponseData> =>
  Option.map(decodeResponseData(response.providerData), (d) => d.fal)

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** The same ref either way; only the phantom result type differs. */
const asQueueRef = (ref: VideoJobRef): Job.JobRef<string> =>
  Job.jobRef<string>(ref.provider, ref.id)

const asVideoRef = (ref: Job.JobRef<string>): VideoJobRef =>
  Job.jobRef<VideoResponse>(ref.provider, ref.id)

const submit = (
  cfg: Config,
  request: FalVideoGenerateRequest,
): Effect.Effect<VideoJobRef, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const body = yield* buildBody(request)
    const raw = yield* Queue.enqueue(cfg, request.model, body)
    return asVideoRef(yield* Queue.accept(request.model, raw))
  })

/** The queue reports the output as a raw body; only `Succeeded` decodes. */
const status = (
  cfg: Config,
  ref: VideoJobRef,
): Effect.Effect<VideoState, AiError.AiError, HttpClient.HttpClient> =>
  Effect.flatMap(
    Queue.status(cfg, asQueueRef(ref)),
    Match.type<Job.JobState<string>>().pipe(
      Match.tag("Succeeded", (state) => toState(state.result)),
      Match.orElse((state): Effect.Effect<VideoState, AiError.AiError> => Effect.succeed(state)),
    ),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<FalVideoGeneratorService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const provide = Effect.provideService(HttpClient.HttpClient, client)
    return {
      submit: (request) => provide(submit(cfg, request)),
      status: (ref) => provide(status(cfg, ref)),
      cancel: (ref) => provide(Queue.cancel(cfg, asQueueRef(ref))),
    }
  })

/**
 * Layer registering the provider-typed tag and the generic
 * `VideoGenerator`. A `CommonVideoGenerateRequest` is structurally a
 * `FalVideoGenerateRequest` with no vendor knobs set, so the generic
 * registration forwards directly.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<FalVideoGenerator | VideoGenerator, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(FalVideoGenerator, make(cfg)),
    Layer.effect(
      VideoGenerator,
      Effect.map(make(cfg), (s): VideoGeneratorService => ({
        submit: (request: CommonVideoGenerateRequest) =>
          s.submit(request as FalVideoGenerateRequest),
        status: s.status,
        cancel: s.cancel,
      })),
    ),
  )
