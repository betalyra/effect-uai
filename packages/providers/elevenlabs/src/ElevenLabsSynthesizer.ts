import { Context, Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import type * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob, AudioChunk } from "@effect-uai/core/Audio"
import {
  type CommonStreamSynthesizeRequest,
  type CommonSynthesizeRequest,
  SpeechSynthesizer,
  type SpeechSynthesizerService,
  TtsIncrementalText,
} from "@effect-uai/core/SpeechSynthesizer"
import { defaultFormat, formatToOutputSlug, httpStatusError, transportFailure } from "./codec.js"
import type { ElevenLabsTtsModel, ElevenLabsVoiceId } from "./models.js"
import { streamSynthesis as realtimeStream, type VoiceSettings } from "./realtimeTts.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * ElevenLabs-typed synthesize request. `voiceSettings` exposes the
 * provider's prosody/timbre controls; `seed` makes generation
 * deterministic; `previousText` / `nextText` thread context across
 * sequential calls for natural prosody.
 */
export type ElevenLabsSynthesizeRequest = Omit<
  CommonSynthesizeRequest,
  "model" | "voiceId"
> & {
  readonly model: ElevenLabsTtsModel
  readonly voiceId: ElevenLabsVoiceId
  readonly voiceSettings?: VoiceSettings
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

const wireVoiceSettings = (v: VoiceSettings | undefined) =>
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
// HTTP plumbing (sync + chunked-HTTP streaming)
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

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (cfg: Config) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const ctor = yield* Socket.WebSocketConstructor
    return {
      synthesize: (r) =>
        synthesizeImpl(cfg)(r).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      streamSynthesis: (r) =>
        streamSynthesisImpl(cfg)(r).pipe(Stream.provideService(HttpClient.HttpClient, client)),
      streamSynthesisFrom: (textIn, request) =>
        realtimeStream(cfg)(textIn, request as ElevenLabsSynthesizeRequest).pipe(
          Stream.provideService(Socket.WebSocketConstructor, ctor),
        ),
    } satisfies ElevenLabsSynthesizerService
  })

/**
 * Layer registers `ElevenLabsSynthesizer`, the generic
 * `SpeechSynthesizer`, **and `TtsIncrementalText`** — incremental
 * text-in is wired to the realtime `/stream-input` WebSocket. Provide
 * `Socket.layerWebSocketConstructorGlobal` and an `HttpClient` Layer at
 * the call site.
 */
export const layer = (cfg: Config) =>
  Layer.mergeAll(
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
          streamSynthesisFrom: (textIn, req: CommonStreamSynthesizeRequest) =>
            s.streamSynthesisFrom(textIn, req),
        }),
      ),
    ),
    Layer.succeed(TtsIncrementalText, undefined),
  )
