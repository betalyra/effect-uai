import { Context, Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob, AudioChunk } from "@effect-uai/core/Audio"
import {
  type CommonStreamSynthesizeRequest,
  type CommonSynthesizeRequest,
  SpeechSynthesizer,
  type SpeechSynthesizerService,
} from "@effect-uai/core/SpeechSynthesizer"
import {
  defaultFormat,
  formatToOutputSlug,
  httpStatusError,
  transportFailure,
} from "./codec.js"
import type { ElevenLabsTtsModel, ElevenLabsVoiceId } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * ElevenLabs-typed synthesize request. `model` narrows to
 * `ElevenLabsTtsModel`. `voiceSettings` exposes the provider's
 * prosody/timbre controls; omit for ElevenLabs's tuned defaults.
 *
 * `seed` makes generation deterministic; `previousText` / `nextText`
 * thread context across sequential calls for natural prosody.
 */
export type ElevenLabsSynthesizeRequest = Omit<
  CommonSynthesizeRequest,
  "model" | "voiceId"
> & {
  readonly model: ElevenLabsTtsModel
  readonly voiceId: ElevenLabsVoiceId
  readonly voiceSettings?: {
    readonly stability?: number
    readonly similarityBoost?: number
    readonly style?: number
    readonly useSpeakerBoost?: boolean
    readonly speed?: number
  }
  readonly seed?: number
  readonly previousText?: string
  readonly nextText?: string
}

export type ElevenLabsSynthesizerService = {
  readonly synthesize: (
    r: ElevenLabsSynthesizeRequest,
  ) => Effect.Effect<AudioBlob, AiError.AiError>
  readonly streamSynthesis: (
    r: ElevenLabsSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamSynthesisFrom: SpeechSynthesizerService["streamSynthesisFrom"]
}

export class ElevenLabsSynthesizer extends Context.Service<
  ElevenLabsSynthesizer,
  ElevenLabsSynthesizerService
>()("@betalyra/effect-uai/providers/elevenlabs/ElevenLabsSynthesizer") {}

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

// ---------------------------------------------------------------------------
// Codec — request → JSON body
// ---------------------------------------------------------------------------

const wireVoiceSettings = (v: ElevenLabsSynthesizeRequest["voiceSettings"]) =>
  v === undefined
    ? undefined
    : {
        ...(v.stability !== undefined && { stability: v.stability }),
        ...(v.similarityBoost !== undefined && { similarity_boost: v.similarityBoost }),
        ...(v.style !== undefined && { style: v.style }),
        ...(v.useSpeakerBoost !== undefined && { use_speaker_boost: v.useSpeakerBoost }),
        ...(v.speed !== undefined && { speed: v.speed }),
      }

const buildBody = (r: ElevenLabsSynthesizeRequest) => ({
  text: r.text,
  model_id: r.model,
  ...(r.languageCode !== undefined && { language_code: r.languageCode }),
  ...(r.seed !== undefined && { seed: r.seed }),
  ...(r.previousText !== undefined && { previous_text: r.previousText }),
  ...(r.nextText !== undefined && { next_text: r.nextText }),
  ...(r.voiceSettings !== undefined && { voice_settings: wireVoiceSettings(r.voiceSettings) }),
})

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config) => cfg.baseUrl ?? "https://api.elevenlabs.io/v1"

const buildHttpRequest = (cfg: Config, r: ElevenLabsSynthesizeRequest, path: "" | "/stream") =>
  Effect.gen(function* () {
    const format = r.outputFormat ?? defaultFormat
    const slug = yield* formatToOutputSlug(format)
    const url = `${baseUrl(cfg)}/text-to-speech/${r.voiceId}${path}?output_format=${slug}`
    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("xi-api-key", Redacted.value(cfg.apiKey)),
      HttpClientRequest.bodyJsonUnsafe(buildBody(r)),
    )
    return { httpRequest, format }
  })

const synthesizeImpl = (cfg: Config) => (request: ElevenLabsSynthesizeRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const { httpRequest, format } = yield* buildHttpRequest(cfg, request, "")
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(httpStatusError(response.status, text))
    }
    const bytes = yield* response.arrayBuffer.pipe(Effect.mapError(transportFailure))
    return { format, bytes: new Uint8Array(bytes) } satisfies AudioBlob
  })

const streamSynthesisImpl = (cfg: Config) => (request: ElevenLabsSynthesizeRequest) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const { httpRequest } = yield* buildHttpRequest(cfg, request, "/stream")
      const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return Stream.fail(httpStatusError(response.status, text))
      }
      return response.stream.pipe(
        Stream.mapError(transportFailure),
        Stream.map((bytes): AudioChunk => ({ bytes })),
      )
    }),
  )

/**
 * ElevenLabs DOES expose a WebSocket `/stream-input` endpoint for
 * incremental text-in, but it's deferred to Phase 2b (needs a custom
 * `WebSocketConstructor` Layer for the `xi-api-key` header). This Layer
 * therefore omits `TtsIncrementalText` — callers using
 * `SpeechSynthesizer.streamSynthesisFrom` against it get a compile-time
 * error.
 */
const unsupportedStreamFrom = <E, R>(
  _textIn: Stream.Stream<string, E, R>,
  _request: CommonStreamSynthesizeRequest,
): Stream.Stream<AudioChunk, AiError.AiError | E, R> => {
  const fail: Stream.Stream<AudioChunk, AiError.AiError | E, R> = Stream.fail(
    new AiError.Unsupported({
      provider: "elevenlabs",
      capability: "streamSynthesisFrom",
      reason:
        "ElevenLabs `/stream-input` WebSocket is not wired in Phase 2a. The Layer omits `TtsIncrementalText`; the bidirectional path ships in Phase 2b.",
    }),
  )
  return fail
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (cfg: Config) =>
  Effect.map(
    HttpClient.HttpClient.asEffect(),
    (client): ElevenLabsSynthesizerService => ({
      synthesize: (r) =>
        synthesizeImpl(cfg)(r).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      streamSynthesis: (r) =>
        streamSynthesisImpl(cfg)(r).pipe(Stream.provideService(HttpClient.HttpClient, client)),
      streamSynthesisFrom: unsupportedStreamFrom,
    }),
  )

/**
 * Layer registers both `ElevenLabsSynthesizer` and the generic
 * `SpeechSynthesizer`. Does NOT register `TtsIncrementalText` —
 * incremental text-in WS ships in Phase 2b.
 */
export const layer = (cfg: Config) =>
  Layer.merge(
    Layer.effect(ElevenLabsSynthesizer, make(cfg)),
    Layer.effect(
      SpeechSynthesizer,
      Effect.map(
        make(cfg),
        (s): SpeechSynthesizerService => ({
          synthesize: (req: CommonSynthesizeRequest) =>
            s.synthesize(req as ElevenLabsSynthesizeRequest),
          streamSynthesis: (req: CommonSynthesizeRequest) =>
            s.streamSynthesis(req as ElevenLabsSynthesizeRequest),
          streamSynthesisFrom: s.streamSynthesisFrom,
        }),
      ),
    ),
  )
