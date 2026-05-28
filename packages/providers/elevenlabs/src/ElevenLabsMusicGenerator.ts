import { Context, Duration, Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import type {
  CommonGenerateMusicRequest,
  CommonStreamGenerateMusicRequest,
  GenerateResult,
  MusicResult,
  MusicSessionInput,
  MusicStreamEvent,
} from "@effect-uai/core/Music"
import { singleVariant } from "@effect-uai/core/Music"
import { MusicGenerator, type MusicGeneratorService } from "@effect-uai/core/MusicGenerator"
import { defaultFormat, formatToOutputSlug } from "./codec.js"
import type { ElevenLabsMusicModel } from "./models.js"
import {
  decodeCompositionPlan,
  type ElevenLabsCompositionPlan,
  warnDroppedPromptModeHints,
  wireCompositionPlan,
} from "./musicCodec.js"
import { type ElevenLabsRegion, resolveHost } from "./region.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * ElevenLabs-typed music request. Narrows `model` to
 * `ElevenLabsMusicModel` and adds provider-specific extras:
 *
 * - `compositionPlan` — switch from prompt mode to plan mode. Mutually
 *   exclusive with `prompt` on the wire.
 * - `forceInstrumental` — skip vocals. ElevenLabs has no `instrumental`
 *   on the cross-provider Common request (the field was removed in
 *   v0.7 because it has wildly different semantics per provider); the
 *   typed surface restores it.
 * - `signWithC2pa` — opt-in C2PA Content Credentials, MP3 output only.
 * - `respectSectionsDurations` — composition-plan mode only. False
 *   trades section-duration accuracy for quality + latency.
 *
 * Setting `compositionPlan` with a non-empty `prompt`, or with
 * `duration`, fails `InvalidRequest` at the codec layer.
 */
export type ElevenLabsMusicGenerateRequest = Omit<CommonGenerateMusicRequest, "model"> & {
  readonly model?: ElevenLabsMusicModel
  readonly compositionPlan?: ElevenLabsCompositionPlan
  readonly forceInstrumental?: boolean
  readonly signWithC2pa?: boolean
  readonly respectSectionsDurations?: boolean
}

export type CreateCompositionPlanRequest = {
  readonly prompt: string
  readonly duration?: Duration.Duration
  readonly sourceCompositionPlan?: ElevenLabsCompositionPlan
  readonly model?: ElevenLabsMusicModel
}

export type ElevenLabsMusicGeneratorService = {
  readonly generate: (
    request: ElevenLabsMusicGenerateRequest,
  ) => Effect.Effect<GenerateResult, AiError.AiError>
  readonly streamGeneration: (
    request: ElevenLabsMusicGenerateRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamGenerationFrom: <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<MusicStreamEvent, AiError.AiError | E, R>
  /**
   * Free endpoint (rate-limited, no credit cost): turn a prompt into a
   * structured `MusicPrompt` plan. Feed the result back into
   * `generate` / `streamGeneration` via `compositionPlan`.
   */
  readonly createCompositionPlan: (
    request: CreateCompositionPlanRequest,
  ) => Effect.Effect<ElevenLabsCompositionPlan, AiError.AiError>
}

export class ElevenLabsMusicGenerator extends Context.Service<
  ElevenLabsMusicGenerator,
  ElevenLabsMusicGeneratorService
>()("@betalyra/effect-uai/providers/elevenlabs/ElevenLabsMusicGenerator") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: ElevenLabsRegion
}

const DEFAULT_MODEL: ElevenLabsMusicModel = "music_v1"

// ---------------------------------------------------------------------------
// HTTP errors (music namespace; reuses the same status taxonomy)
// ---------------------------------------------------------------------------

const musicTransportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "elevenlabs-music", raw: cause })

const musicHttpStatusError = (status: number, body: string): AiError.AiError => {
  if (status === 429) return new AiError.RateLimited({ provider: "elevenlabs-music", raw: body })
  if (status === 408 || status === 504)
    return new AiError.Timeout({ provider: "elevenlabs-music", raw: body })
  if (status === 401)
    return new AiError.AuthFailed({ provider: "elevenlabs-music", subtype: "auth", raw: body })
  if (status === 403)
    return new AiError.AuthFailed({
      provider: "elevenlabs-music",
      subtype: "permission",
      raw: body,
    })
  if (status === 402)
    return new AiError.AuthFailed({
      provider: "elevenlabs-music",
      subtype: "billing",
      raw: body,
    })
  if (status >= 500)
    return new AiError.Unavailable({ provider: "elevenlabs-music", status, raw: body })
  return new AiError.InvalidRequest({ provider: "elevenlabs-music", raw: body })
}

// ---------------------------------------------------------------------------
// Wire body
// ---------------------------------------------------------------------------

/**
 * Build the JSON body for `/v1/music` (sync + stream share the body).
 *
 * Mutual exclusion: `compositionPlan` and prompt-mode fields cannot
 * coexist. When `compositionPlan` is set, `prompt` must be empty and
 * `duration` must be unset (section durations live on the plan).
 */
const buildBody = (request: ElevenLabsMusicGenerateRequest) =>
  Effect.gen(function* () {
    const model = request.model ?? DEFAULT_MODEL
    if (request.compositionPlan !== undefined) {
      if (request.prompt.length > 0) {
        return yield* Effect.fail(
          new AiError.InvalidRequest({
            provider: "elevenlabs-music",
            param: "prompt",
            raw: "`prompt` and `compositionPlan` are mutually exclusive. Pass one or the other (compositionPlan carries its own per-section lyrics and styles).",
          }),
        )
      }
      if (request.duration !== undefined) {
        return yield* Effect.fail(
          new AiError.InvalidRequest({
            provider: "elevenlabs-music",
            param: "duration",
            raw: "`duration` is ignored when `compositionPlan` is set; section durations live on the plan. Remove `duration`.",
          }),
        )
      }
      return {
        composition_plan: wireCompositionPlan(request.compositionPlan),
        model_id: model,
        ...(request.seed !== undefined && { seed: request.seed }),
        ...(request.forceInstrumental !== undefined && {
          force_instrumental: request.forceInstrumental,
        }),
        ...(request.respectSectionsDurations !== undefined && {
          respect_sections_durations: request.respectSectionsDurations,
        }),
        ...(request.signWithC2pa !== undefined && { sign_with_c2pa: request.signWithC2pa }),
      }
    }
    yield* warnDroppedPromptModeHints(request as CommonGenerateMusicRequest)
    return {
      prompt: request.prompt,
      model_id: model,
      ...(request.duration !== undefined && {
        music_length_ms: Duration.toMillis(request.duration),
      }),
      ...(request.seed !== undefined && { seed: request.seed }),
      ...(request.forceInstrumental !== undefined && {
        force_instrumental: request.forceInstrumental,
      }),
      ...(request.signWithC2pa !== undefined && { sign_with_c2pa: request.signWithC2pa }),
    }
  })

const buildMusicHttpRequest = (
  cfg: Config,
  request: ElevenLabsMusicGenerateRequest,
  path: "" | "/stream",
) =>
  Effect.gen(function* () {
    const format: AudioFormat = request.outputFormat ?? defaultFormat
    const slug = yield* formatToOutputSlug(format)
    const body = yield* buildBody(request)
    const url = `${resolveHost(cfg)}/music${path}?output_format=${slug}`
    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("xi-api-key", Redacted.value(cfg.apiKey)),
      HttpClientRequest.bodyJsonUnsafe(body),
    )
    return { httpRequest, format }
  })

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const generateImpl =
  (cfg: Config) =>
  (
    request: ElevenLabsMusicGenerateRequest,
  ): Effect.Effect<GenerateResult, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const { httpRequest, format } = yield* buildMusicHttpRequest(cfg, request, "")
      const response = yield* client
        .execute(httpRequest)
        .pipe(Effect.mapError(musicTransportFailure))
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.fail(musicHttpStatusError(response.status, text))
      }
      const buffer = yield* response.arrayBuffer.pipe(Effect.mapError(musicTransportFailure))
      const bytes = new Uint8Array(buffer)
      const songId = response.headers["song_id"] ?? response.headers["x-song-id"]
      const result: MusicResult = {
        audio: { format, bytes },
        provider: "elevenlabs-music",
        ...(typeof songId === "string" && { songId }),
        ...(request.signWithC2pa === true && { watermark: "c2pa" as const }),
      }
      return singleVariant(result)
    })

const streamGenerationImpl =
  (cfg: Config) =>
  (
    request: ElevenLabsMusicGenerateRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const { httpRequest } = yield* buildMusicHttpRequest(cfg, request, "/stream")
        const response = yield* client
          .execute(httpRequest)
          .pipe(Effect.mapError(musicTransportFailure))
        if (response.status >= 400) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return Stream.fail(musicHttpStatusError(response.status, text))
        }
        return response.stream.pipe(
          Stream.mapError(musicTransportFailure),
          Stream.map((bytes): AudioChunk => ({ bytes })),
        )
      }),
    )

/**
 * ElevenLabs music has no bidirectional session at the wire level.
 * Layer does not register `MusicInteractiveSession`, so callers using
 * `MusicGenerator.streamGenerationFrom` get a compile-time error
 * before this runtime fallback fires.
 */
const streamGenerationFromUnsupported = <E, R>(
  _input: Stream.Stream<MusicSessionInput, E, R>,
  _request: CommonStreamGenerateMusicRequest,
): Stream.Stream<MusicStreamEvent, AiError.AiError | E, R> =>
  Stream.fail(
    new AiError.Unsupported({
      provider: "elevenlabs-music",
      capability: "streamGenerationFrom",
      reason:
        "ElevenLabs music has no bidirectional session. Use `streamGeneration` for chunked output, or `createCompositionPlan` + `generate` for structured plans.",
    }),
  )

const createCompositionPlanImpl =
  (cfg: Config) =>
  (
    request: CreateCompositionPlanRequest,
  ): Effect.Effect<ElevenLabsCompositionPlan, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const body = {
        prompt: request.prompt,
        model_id: request.model ?? DEFAULT_MODEL,
        ...(request.duration !== undefined && {
          music_length_ms: Duration.toMillis(request.duration),
        }),
        ...(request.sourceCompositionPlan !== undefined && {
          source_composition_plan: wireCompositionPlan(request.sourceCompositionPlan),
        }),
      }
      const httpRequest = HttpClientRequest.post(`${resolveHost(cfg)}/music/plan`).pipe(
        HttpClientRequest.setHeader("xi-api-key", Redacted.value(cfg.apiKey)),
        HttpClientRequest.bodyJsonUnsafe(body),
      )
      const response = yield* client
        .execute(httpRequest)
        .pipe(Effect.mapError(musicTransportFailure))
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.fail(musicHttpStatusError(response.status, text))
      }
      const json = yield* response.json.pipe(Effect.mapError(musicTransportFailure))
      return decodeCompositionPlan(json)
    })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<ElevenLabsMusicGeneratorService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    generate: (request) =>
      generateImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamGeneration: (request) =>
      streamGenerationImpl(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client)),
    streamGenerationFrom: streamGenerationFromUnsupported,
    createCompositionPlan: (request) =>
      createCompositionPlanImpl(cfg)(request).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ),
  }))

/**
 * Layer that registers the provider-specific `ElevenLabsMusicGenerator`
 * tag and the generic `MusicGenerator` tag.
 *
 * Does NOT register `MusicInteractiveSession`. ElevenLabs music has no
 * bidirectional wire endpoint; `streamGenerationFrom` against this
 * Layer alone fails to typecheck.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<ElevenLabsMusicGenerator | MusicGenerator, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(ElevenLabsMusicGenerator, make(cfg)),
    Layer.effect(
      MusicGenerator,
      Effect.map(
        make(cfg),
        (s): MusicGeneratorService => ({
          generate: (req: CommonGenerateMusicRequest) =>
            s.generate({ ...req, model: req.model as ElevenLabsMusicModel }),
          streamGeneration: (req: CommonStreamGenerateMusicRequest) =>
            s.streamGeneration({ ...req, model: req.model as ElevenLabsMusicModel }),
          streamGenerationFrom: s.streamGenerationFrom,
        }),
      ),
    ),
  )
