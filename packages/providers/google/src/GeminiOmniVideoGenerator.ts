import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
  Stream,
  pipe,
} from "effect"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import type { ImageSource } from "@effect-uai/core/Image"
import * as Job from "@effect-uai/core/Job"
import type { GeneratedVideo, VideoSource } from "@effect-uai/core/Video"
import { VideoInput, videoBase64, videoRef, videoUrl } from "@effect-uai/core/Video"
import * as VideoDownload from "@effect-uai/core/VideoDownload"
import type {
  CommonVideoGenerateRequest,
  VideoGeneratorServiceShape,
  VideoJobRef,
  VideoResponse,
  VideoState,
  VideoUsage,
} from "@effect-uai/core/VideoGenerator"
import { VideoGenerator } from "@effect-uai/core/VideoGenerator"
import {
  InteractionError,
  interactionFailure,
  interactionHttpError,
  transportFailure,
} from "./codec.js"
import type { GeminiOmniVideoModel } from "./models.js"

const PROVIDER = "gemini"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** What the inputs are for. Omni has no per-image roles; the task carries them. */
export type GeminiOmniTask = "text_to_video" | "image_to_video" | "reference_to_video"

export type GeminiOmniVideoGenerateRequest = Omit<CommonVideoGenerateRequest, "model"> & {
  readonly model: GeminiOmniVideoModel
  /**
   * `uri` (default): the clip stays in Google's Files API and comes back as a
   * `ref`, read with `read`. `inline`: base64 in the poll response, capped
   * near 4 MB (a 720p clip of about 10 s).
   */
  readonly delivery?: "uri" | "inline"
  /** Overrides the task the inputs imply. */
  readonly task?: GeminiOmniTask
}

export type GeminiOmniVideoGeneratorService =
  VideoGeneratorServiceShape<GeminiOmniVideoGenerateRequest>

/**
 * Provider-typed tag for Gemini Omni over the Interactions API in background
 * mode. Yield this for `delivery` and `task`; yield the generic
 * `VideoGenerator` tag for portable code. Both are registered by {@link layer}.
 */
export class GeminiOmniVideoGenerator extends Context.Service<
  GeminiOmniVideoGenerator,
  GeminiOmniVideoGeneratorService
>()("@betalyra/effect-uai/providers/google/GeminiOmniVideoGenerator") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request
// ---------------------------------------------------------------------------

type WireImage = { readonly type: "image"; readonly data: string; readonly mime_type: string }

const unsupported = (capability: string, reason: string): AiError.AiError =>
  new AiError.Unsupported({ provider: PROVIDER, capability, reason })

/** Interactions takes images inline or as Files API URIs; we do not pre-upload. */
const imagePart = (image: ImageSource): Effect.Effect<WireImage, AiError.AiError> =>
  Match.value(image).pipe(
    Match.tag("base64", (i) =>
      Effect.succeed<WireImage>({ type: "image", data: i.base64, mime_type: i.mimeType }),
    ),
    Match.tag("bytes", (i) =>
      Effect.succeed<WireImage>({
        type: "image",
        data: Base64.encode(i.bytes),
        mime_type: i.mimeType,
      }),
    ),
    Match.tag("url", () =>
      Effect.fail(
        unsupported("image", "Omni takes images inline; fetch the URL and pass bytes or base64."),
      ),
    ),
    Match.exhaustive,
  )

type WireVideo =
  | { readonly type: "video"; readonly uri: string }
  | { readonly type: "video"; readonly data: string; readonly mime_type: string }

/** Our own ref goes back as its Files API URI, so a generated clip is reused without a download. */
const videoPart = (host: string, video: VideoSource): Effect.Effect<WireVideo, AiError.AiError> =>
  Match.value(video).pipe(
    Match.tag("ref", (v) =>
      v.provider === PROVIDER
        ? Effect.succeed<WireVideo>({ type: "video", uri: `${host}/${v.id}` })
        : Effect.fail(
            unsupported("video", `A ${v.provider} file reference cannot be sent to Omni.`),
          ),
    ),
    Match.tag("base64", (v) =>
      Effect.succeed<WireVideo>({ type: "video", data: v.base64, mime_type: v.mimeType }),
    ),
    Match.tag("bytes", (v) =>
      Effect.succeed<WireVideo>({
        type: "video",
        data: Base64.encode(v.bytes),
        mime_type: v.mimeType,
      }),
    ),
    Match.tag("url", () =>
      Effect.fail(unsupported("video", "Omni takes videos inline or as its own file references.")),
    ),
    Match.exhaustive,
  )

type Roles = {
  readonly first: ReadonlyArray<ImageSource>
  readonly last: ReadonlyArray<ImageSource>
  readonly images: ReadonlyArray<ImageSource>
  readonly videos: ReadonlyArray<VideoSource>
}

const rolesOf = (inputs: ReadonlyArray<VideoInput>): Roles =>
  Arr.reduce(inputs, { first: [], last: [], images: [], videos: [] } as Roles, (roles, input) =>
    VideoInput.$match(input, {
      FirstFrame: ({ image }) => ({ ...roles, first: [...roles.first, image] }),
      LastFrame: ({ image }) => ({ ...roles, last: [...roles.last, image] }),
      ReferenceImage: ({ image }) => ({ ...roles, images: [...roles.images, image] }),
      ReferenceVideo: ({ video }) => ({ ...roles, videos: [...roles.videos, video] }),
    }),
  )

type Plan = {
  readonly task: Option.Option<GeminiOmniTask>
  readonly images: ReadonlyArray<ImageSource>
  readonly videos: ReadonlyArray<VideoSource>
}

/**
 * Omni reads images by position (first frame, then last frame) and by task,
 * so the roles the caller named become the task. A combination no task
 * covers fails rather than being guessed at.
 */
const planOf = (inputs: ReadonlyArray<VideoInput>): Effect.Effect<Plan, AiError.AiError> => {
  const { first, last, images, videos } = rolesOf(inputs)
  const references = images.length + videos.length
  return Match.value({ first: first.length, last: last.length, references }).pipe(
    Match.when({ first: 0, last: 0, references: 0 }, () =>
      Effect.succeed<Plan>({ task: Option.none(), images: [], videos: [] }),
    ),
    Match.when({ first: 0, last: 0 }, () =>
      Effect.succeed<Plan>({ task: Option.some("reference_to_video"), images, videos }),
    ),
    Match.when(
      ({ first: f, last: l, references: r }) => f === 1 && l <= 1 && r === 0,
      () =>
        Effect.succeed<Plan>({
          task: Option.some("image_to_video"),
          images: [...first, ...last],
          videos: [],
        }),
    ),
    Match.orElse(() =>
      Effect.fail(
        unsupported(
          "inputs",
          "Omni takes one first frame (optionally with one last frame), or references, not a mix; a last frame needs a first frame.",
        ),
      ),
    ),
  )
}

const AspectRatio = Schema.Literals(["16:9", "9:16"])
const Resolution = Schema.Literals(["360p", "720p", "1080p", "4k"])

/** A value Omni has no spelling for fails before the request, naming the ones it has. */
const checked = <A extends string>(
  schema: Schema.Literals<ReadonlyArray<A>>,
  field: string,
  value: string | undefined,
): Effect.Effect<Option.Option<A>, AiError.AiError> =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => Effect.succeedNone,
    onSome: (v) =>
      Option.match(Schema.decodeUnknownOption(schema)(v), {
        onNone: () =>
          Effect.fail(
            unsupported(field, `Omni takes ${field} ${schema.literals.join(", ")}, not ${v}.`),
          ),
        onSome: Effect.succeedSome,
      }),
  })

const optionalField = <A>(key: string, value: Option.Option<A>): Record<string, A> =>
  Option.match(value, { onNone: () => ({}), onSome: (v) => ({ [key]: v }) })

/** `host` is the configured API root, which a Gemini file ref's URI hangs off. */
export const buildBody = (
  request: GeminiOmniVideoGenerateRequest,
  host: string,
): Effect.Effect<Record<string, unknown>, AiError.AiError> =>
  Effect.gen(function* () {
    yield* Capabilities.warnDroppedWhen(request.seed, {
      provider: PROVIDER,
      capability: "seed",
      field: "seed",
      reason: "Omni takes no seed.",
    })
    const plan = yield* planOf(request.inputs ?? [])
    const images = yield* Effect.forEach(plan.images, imagePart)
    const videos = yield* Effect.forEach(plan.videos, (video) => videoPart(host, video))
    const aspectRatio = yield* checked(AspectRatio, "aspectRatio", request.aspectRatio)
    const resolution = yield* checked(Resolution, "resolution", request.resolution)
    // Whole seconds, spelled "8s"; Omni renders 3 to 15.
    const duration = Option.map(
      Option.fromNullishOr(request.duration),
      (d) => `${Math.round(Duration.toSeconds(d))}s`,
    )
    const task = Option.orElse(Option.fromNullishOr(request.task), () => plan.task)
    return {
      model: request.model,
      input: [...images, ...videos, { type: "text", text: request.prompt }],
      response_format: {
        type: "video",
        delivery: request.delivery ?? "uri",
        ...optionalField("aspect_ratio", aspectRatio),
        ...optionalField("resolution", resolution),
        ...optionalField("duration", duration),
      },
      ...optionalField(
        "generation_config",
        Option.map(task, (t) => ({ video_config: { task: t } })),
      ),
      background: true,
      store: true,
    }
  })

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireVideoPart = Schema.Struct({
  type: Schema.Literal("video"),
  data: Schema.optionalKey(Schema.String),
  uri: Schema.optionalKey(Schema.String),
  mime_type: Schema.optionalKey(Schema.String),
})
type WireVideoPart = typeof WireVideoPart.Type
const isVideoPart = Schema.is(WireVideoPart)

export const WireInteraction = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  steps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      }),
    ),
  ),
  usage: Schema.optionalKey(
    Schema.Struct({
      total_input_tokens: Schema.optionalKey(Schema.Finite),
      total_output_tokens: Schema.optionalKey(Schema.Finite),
      total_tokens: Schema.optionalKey(Schema.Finite),
    }),
  ),
  /** Where a failed background interaction records why. */
  errors: Schema.optionalKey(Schema.Array(InteractionError)),
})
export type WireInteraction = typeof WireInteraction.Type

const decodeInteraction = Schema.decodeUnknownEffect(WireInteraction)
const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

/**
 * The Files API resource name (`files/abc`) behind a download URI
 * (`.../v1beta/files/abc:download?alt=media`): the path segment after
 * `files`, without Google's `:method` suffix. Kept as the ref's id, so the
 * download URL is rebuilt from the configured host rather than stored.
 */
export const fileNameOf = (uri: string): Option.Option<string> =>
  pipe(
    decodeUrl(uri),
    Option.map((url) => url.pathname.split("/").filter((segment) => segment.length > 0)),
    Option.flatMap((segments) =>
      Option.flatMap(
        Arr.findFirstIndex(segments, (s) => s === "files"),
        (i) => Arr.get(segments, i + 1),
      ),
    ),
    Option.flatMap((segment) => Arr.head(segment.split(":"))),
    Option.filter((id) => id.length > 0),
    Option.map((id) => `files/${id}`),
  )

const missingVideo = (raw: unknown): AiError.AiError =>
  new AiError.GenerationFailed({
    provider: PROVIDER,
    message: "Omni returned a video part with no readable data or file URI.",
    raw,
  })

/** Omni stamps SynthID into every clip. */
const generatedVideo = (part: WireVideoPart): Effect.Effect<GeneratedVideo, AiError.AiError> => {
  const mimeType = part.mime_type ?? "video/mp4"
  return Match.value(part).pipe(
    Match.when({ data: Match.string }, (p) =>
      Effect.succeed<VideoSource>(videoBase64(p.data, mimeType)),
    ),
    Match.when({ uri: Match.string }, (p) =>
      Option.match(fileNameOf(p.uri), {
        onNone: () => Effect.fail(missingVideo(p)),
        onSome: (name) => Effect.succeed<VideoSource>(videoRef(PROVIDER, name, mimeType)),
      }),
    ),
    Match.orElse((p) => Effect.fail(missingVideo(p))),
    Effect.map((video): GeneratedVideo => ({ video, watermark: "synthid" })),
  )
}

const videoPartsOf = (wire: WireInteraction): ReadonlyArray<WireVideoPart> =>
  (wire.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => (step.content ?? []).filter(isVideoPart))

const usageOf = (wire: WireInteraction): VideoUsage => ({
  ...(wire.usage?.total_input_tokens !== undefined && {
    inputTokens: wire.usage.total_input_tokens,
  }),
  ...(wire.usage?.total_output_tokens !== undefined && {
    outputTokens: wire.usage.total_output_tokens,
  }),
  ...(wire.usage?.total_tokens !== undefined && { totalTokens: wire.usage.total_tokens }),
})

/** A safety block is `ContentFiltered`; the rest `GenerationFailed`, with Omni's message. */
const failed = (wire: WireInteraction, reason: string): VideoState =>
  Job.JobState.Failed({ error: interactionFailure(PROVIDER, wire.errors ?? [], reason, wire) })

const settled = (wire: WireInteraction): Effect.Effect<VideoState, AiError.AiError> => {
  const parts = videoPartsOf(wire)
  return parts.length === 0
    ? Effect.succeed(failed(wire, "Omni completed without a video."))
    : Effect.map(Effect.forEach(parts, generatedVideo), (videos): VideoState =>
        Job.JobState.Succeeded({ result: { videos, usage: usageOf(wire) } }),
      )
}

/**
 * The Interactions status. Every value that needs the caller to act
 * (`requires_action`, `requires_continuation`) ends the job: a video
 * generation has nothing to answer them with. An unknown one keeps polling:
 * the job may still be running (and billing), and the timeout bounds the wait.
 */
export const stateOf = (wire: WireInteraction): Effect.Effect<VideoState, AiError.AiError> =>
  Match.value(wire.status).pipe(
    Match.when("queued", () => Effect.succeed<VideoState>(Job.JobState.Pending({}))),
    Match.when("in_progress", () => Effect.succeed<VideoState>(Job.JobState.Running())),
    Match.when("completed", () => settled(wire)),
    Match.whenOr(
      "failed",
      "cancelled",
      "incomplete",
      "budget_exceeded",
      "requires_action",
      "requires_continuation",
      (s) => Effect.succeed(failed(wire, `Omni ended the job as ${s}.`)),
    ),
    Match.orElse(() => Effect.succeed<VideoState>(Job.JobState.Running())),
  )

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const host = (cfg: Config): string =>
  cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"

const send = (
  cfg: Config,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<unknown, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(HttpClientRequest.setHeader(request, "x-goog-api-key", Redacted.value(cfg.apiKey)))
      .pipe(Effect.mapError(transportFailure(PROVIDER)))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* interactionHttpError(PROVIDER)(response.status, text)
    }
    return yield* response.json.pipe(Effect.mapError(unreadable))
  })

/**
 * A 2xx we cannot read is not transient: `Retry` would resend a `submit`
 * Omni already accepted and pay for a second clip.
 */
const unreadable = (cause: unknown): AiError.AiError =>
  new AiError.GenerationFailed({
    provider: PROVIDER,
    message: "Omni returned a response we could not read.",
    raw: cause,
  })

const interaction = (json: unknown) => decodeInteraction(json).pipe(Effect.mapError(unreadable))

const submit = (cfg: Config, request: GeminiOmniVideoGenerateRequest) =>
  Effect.gen(function* () {
    const body = yield* buildBody(request, host(cfg))
    const json = yield* send(
      cfg,
      HttpClientRequest.post(`${host(cfg)}/interactions`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    )
    const wire = yield* interaction(json)
    return Job.jobRef<VideoResponse>(PROVIDER, wire.id)
  })

const status = (cfg: Config, ref: VideoJobRef) =>
  Job.own(PROVIDER)(ref).pipe(
    Effect.flatMap((own) =>
      send(cfg, HttpClientRequest.get(`${host(cfg)}/interactions/${own.id}`)),
    ),
    Effect.flatMap(interaction),
    Effect.flatMap(stateOf),
  )

const cancel = (cfg: Config, ref: VideoJobRef) =>
  Job.own(PROVIDER)(ref).pipe(
    Effect.flatMap((own) =>
      send(cfg, HttpClientRequest.post(`${host(cfg)}/interactions/${own.id}/cancel`)),
    ),
    Effect.asVoid,
  )

/**
 * Our own refs download from the Files API with the key; everything else
 * (inline data, a foreign ref) goes through the shared reader, which never
 * sees the key.
 */
const read = (cfg: Config, video: VideoSource) =>
  video._tag === "ref" && video.provider === PROVIDER
    ? VideoDownload.read(videoUrl(`${host(cfg)}/${video.id}:download?alt=media`), {
        provider: PROVIDER,
        headers: { "x-goog-api-key": Redacted.value(cfg.apiKey) },
      })
    : VideoDownload.read(video, { provider: PROVIDER })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<GeminiOmniVideoGeneratorService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const provide = Effect.provideService(HttpClient.HttpClient, client)
    return {
      submit: (request) => provide(submit(cfg, request)),
      status: (ref) => provide(status(cfg, ref)),
      cancel: (ref) => provide(cancel(cfg, ref)),
      read: (video) => read(cfg, video).pipe(Stream.provideService(HttpClient.HttpClient, client)),
    }
  })

/**
 * Layer registering the provider-typed tag and the generic `VideoGenerator`,
 * both backed by one service.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<GeminiOmniVideoGenerator | VideoGenerator, never, HttpClient.HttpClient> =>
  Layer.effectContext(
    Effect.map(make(cfg), (service) =>
      Context.make(GeminiOmniVideoGenerator, service).pipe(Context.add(VideoGenerator, service)),
    ),
  )
