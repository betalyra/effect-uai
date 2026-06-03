import { Context, Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import type * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob, AudioChunk } from "@effect-uai/core/Audio"
import {
  type CommonStreamSynthesizeRequest,
  type CommonSynthesizeDialogueRequest,
  type CommonSynthesizeRequest,
  MultiSpeakerTts,
  SpeechSynthesizer,
  type SpeechSynthesizerService,
  TtsIncrementalText,
} from "@effect-uai/core/SpeechSynthesizer"
import {
  defaultFormat,
  formatToOutputSlug,
  httpStatusError,
  type PronunciationDictionaryLocator,
  rejectInlinePronunciations,
  transportFailure,
  type VoiceSettings,
  wirePronunciationLocators,
  wireVoiceSettings,
} from "./codec.js"
import type { ElevenLabsTtsModel, ElevenLabsVoiceId } from "./models.js"
import { streamSynthesis as realtimeStream } from "./realtimeTts.js"
import { type ElevenLabsRegion, resolveHost } from "./region.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * ElevenLabs-typed synthesize request. `voiceSettings` exposes the
 * provider's prosody/timbre controls; `seed` makes generation
 * deterministic; `previousText` / `nextText` thread context across
 * sequential calls for natural prosody.
 *
 * `pronunciationDictionaryLocators` references pre-provisioned
 * pronunciation dictionaries by ID. Inline `pronunciations` (IPA) on
 * the Common request are not supported by ElevenLabs and fail
 * `Unsupported`; use a dictionary for phonetic control.
 */
export type ElevenLabsSynthesizeRequest = Omit<CommonSynthesizeRequest, "model" | "voiceId"> & {
  readonly model: ElevenLabsTtsModel
  readonly voiceId: ElevenLabsVoiceId
  readonly voiceSettings?: VoiceSettings
  readonly seed?: number
  readonly previousText?: string
  readonly nextText?: string
  readonly pronunciationDictionaryLocators?: ReadonlyArray<PronunciationDictionaryLocator>
}

export type ElevenLabsSynthesizerService = {
  readonly synthesize: (r: ElevenLabsSynthesizeRequest) => Effect.Effect<AudioBlob, AiError.AiError>
  readonly streamSynthesis: (
    r: ElevenLabsSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamSynthesisFrom: SpeechSynthesizerService["streamSynthesisFrom"]
  readonly synthesizeDialogue: SpeechSynthesizerService["synthesizeDialogue"]
  readonly streamSynthesizeDialogue: SpeechSynthesizerService["streamSynthesizeDialogue"]
}

export class ElevenLabsSynthesizer extends Context.Service<
  ElevenLabsSynthesizer,
  ElevenLabsSynthesizerService
>()("@betalyra/effect-uai/providers/elevenlabs/ElevenLabsSynthesizer") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: ElevenLabsRegion
}

// ---------------------------------------------------------------------------
// Codec — request → JSON body
// ---------------------------------------------------------------------------

const buildBody = (r: ElevenLabsSynthesizeRequest) => ({
  text: r.text,
  model_id: r.model,
  ...(r.languageCode !== undefined && { language_code: r.languageCode }),
  ...(r.seed !== undefined && { seed: r.seed }),
  ...(r.previousText !== undefined && { previous_text: r.previousText }),
  ...(r.nextText !== undefined && { next_text: r.nextText }),
  ...wirePronunciationLocators(r.pronunciationDictionaryLocators),
  ...(r.voiceSettings !== undefined && { voice_settings: wireVoiceSettings(r.voiceSettings) }),
})

// ---------------------------------------------------------------------------
// Dialogue — POST /v1/text-to-dialogue (+ /stream variant)
// ---------------------------------------------------------------------------

const DEFAULT_DIALOGUE_MODEL = "eleven_v3"

const buildDialogueBody = (r: CommonSynthesizeDialogueRequest) => ({
  inputs: r.turns.map((t) => ({
    voice_id: t.voiceId,
    text: t.text,
  })),
  model_id: r.model ?? DEFAULT_DIALOGUE_MODEL,
  ...(r.languageCode !== undefined && { language_code: r.languageCode }),
})

const buildDialogueHttpRequest = (
  cfg: Config,
  r: CommonSynthesizeDialogueRequest,
  path: "" | "/stream",
) =>
  Effect.gen(function* () {
    const format = r.outputFormat ?? defaultFormat
    const slug = yield* formatToOutputSlug(format)
    const url = `${resolveHost(cfg)}/text-to-dialogue${path}?output_format=${slug}`
    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("xi-api-key", Redacted.value(cfg.apiKey)),
      HttpClientRequest.bodyJsonUnsafe(buildDialogueBody(r)),
    )
    return { httpRequest, format }
  })

const synthesizeDialogueImpl = (cfg: Config) => (request: CommonSynthesizeDialogueRequest) =>
  Effect.gen(function* () {
    yield* rejectInlinePronunciations(request.pronunciations)
    const client = yield* HttpClient.HttpClient
    const { httpRequest, format } = yield* buildDialogueHttpRequest(cfg, request, "")
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(httpStatusError(response.status, text))
    }
    const bytes = yield* response.arrayBuffer.pipe(Effect.mapError(transportFailure))
    return { format, bytes: new Uint8Array(bytes) } satisfies AudioBlob
  })

const streamSynthesizeDialogueImpl = (cfg: Config) => (request: CommonSynthesizeDialogueRequest) =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* rejectInlinePronunciations(request.pronunciations)
      const client = yield* HttpClient.HttpClient
      const { httpRequest } = yield* buildDialogueHttpRequest(cfg, request, "/stream")
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
// HTTP plumbing (sync + chunked-HTTP streaming)
// ---------------------------------------------------------------------------

const buildHttpRequest = (cfg: Config, r: ElevenLabsSynthesizeRequest, path: "" | "/stream") =>
  Effect.gen(function* () {
    const format = r.outputFormat ?? defaultFormat
    const slug = yield* formatToOutputSlug(format)
    const url = `${resolveHost(cfg)}/text-to-speech/${r.voiceId}${path}?output_format=${slug}`
    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("xi-api-key", Redacted.value(cfg.apiKey)),
      HttpClientRequest.bodyJsonUnsafe(buildBody(r)),
    )
    return { httpRequest, format }
  })

const synthesizeImpl = (cfg: Config) => (request: ElevenLabsSynthesizeRequest) =>
  Effect.gen(function* () {
    yield* rejectInlinePronunciations(request.pronunciations)
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
      yield* rejectInlinePronunciations(request.pronunciations)
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
      synthesizeDialogue: (request) =>
        synthesizeDialogueImpl(cfg)(request).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
      streamSynthesizeDialogue: (request) =>
        streamSynthesizeDialogueImpl(cfg)(request).pipe(
          Stream.provideService(HttpClient.HttpClient, client),
        ),
    } satisfies ElevenLabsSynthesizerService
  })

/**
 * Layer registers `ElevenLabsSynthesizer`, the generic
 * `SpeechSynthesizer`, the `TtsIncrementalText` marker (incremental
 * text-in via `/stream-input` WebSocket), **and `MultiSpeakerTts`** —
 * multi-speaker dialogue is wired to `POST /v1/text-to-dialogue`
 * (sync) and `/v1/text-to-dialogue/stream` (chunked). Provide
 * `Socket.layerWebSocketConstructorGlobal` and an `HttpClient` Layer
 * at the call site.
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
          synthesizeDialogue: s.synthesizeDialogue,
          streamSynthesizeDialogue: s.streamSynthesizeDialogue,
        }),
      ),
    ),
    Layer.succeed(TtsIncrementalText, undefined),
    Layer.succeed(MultiSpeakerTts, undefined),
  )
