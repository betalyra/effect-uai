import { Context, Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob, AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import {
  type CommonStreamSynthesizeRequest,
  type CommonSynthesizeRequest,
  SpeechSynthesizer,
  type SpeechSynthesizerService,
} from "@effect-uai/core/SpeechSynthesizer"
import {
  containerToResponseFormat,
  httpStatusError,
  type OpenAIResponseFormat,
  realizedFormat,
  transportFailure,
} from "./codec.js"
import type { OpenAITtsModel, OpenAIVoiceId } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * OpenAI-typed synthesize request. `model` narrows to `OpenAITtsModel`;
 * `voiceId` narrows to the stock-only `OpenAIVoiceId` union (no
 * `(string & {})` escape — OpenAI has no custom-voice path).
 *
 * `instructions` is honoured only by `gpt-4o-mini-tts`; it's silently
 * ignored on `tts-1` / `tts-1-hd`.
 */
export type OpenAISynthesizeRequest = Omit<CommonSynthesizeRequest, "model" | "voiceId"> & {
  readonly model: OpenAITtsModel
  readonly voiceId: OpenAIVoiceId
  readonly instructions?: string
}

export type OpenAISynthesizerService = {
  readonly synthesize: (
    request: OpenAISynthesizeRequest,
  ) => Effect.Effect<AudioBlob, AiError.AiError>
  readonly streamSynthesis: (
    request: OpenAISynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamSynthesisFrom: <E, R>(
    textIn: Stream.Stream<string, E, R>,
    request: CommonStreamSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R>
}

export class OpenAISynthesizer extends Context.Service<
  OpenAISynthesizer,
  OpenAISynthesizerService
>()("@betalyra/effect-uai/providers/openai/OpenAISynthesizer") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec — request → JSON body
// ---------------------------------------------------------------------------

const defaultFormat: AudioFormat = {
  container: "mp3",
  encoding: "mp3",
  sampleRate: 24000,
}

type WireBody = {
  readonly model: string
  readonly input: string
  readonly voice: string
  readonly response_format: OpenAIResponseFormat
  readonly speed?: number
  readonly instructions?: string
}

const buildBody = (
  request: OpenAISynthesizeRequest,
): Effect.Effect<{ readonly body: WireBody; readonly format: AudioFormat }, AiError.AiError> =>
  containerToResponseFormat((request.outputFormat ?? defaultFormat).container).pipe(
    Effect.map((responseFormat) => ({
      body: {
        model: request.model,
        input: request.text,
        voice: request.voiceId,
        response_format: responseFormat,
        ...(request.speed !== undefined && { speed: request.speed }),
        ...(request.instructions !== undefined && { instructions: request.instructions }),
      } satisfies WireBody,
      format: realizedFormat(responseFormat),
    })),
  )

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://api.openai.com/v1"

const buildHttpRequest = (cfg: Config, body: WireBody) =>
  HttpClientRequest.post(`${baseUrl(cfg)}/audio/speech`).pipe(
    HttpClientRequest.bearerToken(cfg.apiKey),
    HttpClientRequest.bodyJsonUnsafe(body),
  )

const synthesizeImpl =
  (cfg: Config) =>
  (
    request: OpenAISynthesizeRequest,
  ): Effect.Effect<AudioBlob, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const { body, format } = yield* buildBody(request)
      const response = yield* client
        .execute(buildHttpRequest(cfg, body))
        .pipe(Effect.mapError(transportFailure))
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.fail(httpStatusError(response.status, text))
      }
      const bytes = yield* response.arrayBuffer.pipe(Effect.mapError(transportFailure))
      return { format, bytes: new Uint8Array(bytes) }
    })

const streamSynthesisImpl =
  (cfg: Config) =>
  (
    request: OpenAISynthesizeRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const { body } = yield* buildBody(request)
        const response = yield* client
          .execute(buildHttpRequest(cfg, body))
          .pipe(Effect.mapError(transportFailure))
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
// streamSynthesisFrom — Unsupported (OpenAI has no incremental text-in)
// ---------------------------------------------------------------------------

/**
 * OpenAI has no incremental-text-in TTS endpoint at the wire level.
 * The provider Layer also does NOT register the `TtsIncrementalText`
 * capability marker, so callers using
 * `SpeechSynthesizer.streamSynthesisFrom` against only OpenAI's Layer
 * get a compile-time error before this runtime fallback ever fires.
 */
const streamSynthesisFromUnsupported = <E, R>(
  _textIn: Stream.Stream<string, E, R>,
  _request: CommonStreamSynthesizeRequest,
): Stream.Stream<AudioChunk, AiError.AiError | E, R> => {
  const fail: Stream.Stream<AudioChunk, AiError.AiError | E, R> = Stream.fail(
    new AiError.Unsupported({
      provider: "openai",
      capability: "streamSynthesisFrom",
      reason:
        "OpenAI does not offer an incremental-text-in TTS endpoint. Use `synthesize` (full text in, full audio out) or `streamSynthesis` (full text in, chunked audio out).",
    }),
  )
  return fail
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<OpenAISynthesizerService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    synthesize: (request) =>
      synthesizeImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamSynthesis: (request) =>
      streamSynthesisImpl(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client)),
    streamSynthesisFrom: streamSynthesisFromUnsupported,
  }))

/**
 * Layer that registers both `OpenAISynthesizer` and the generic
 * `SpeechSynthesizer` tag.
 *
 * Does NOT register the `TtsIncrementalText` capability marker —
 * OpenAI has no incremental-text-in TTS at the wire level. Code calling
 * `SpeechSynthesizer.streamSynthesisFrom` will fail to typecheck
 * against this Layer alone, which is the intended UX.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<OpenAISynthesizer | SpeechSynthesizer, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(OpenAISynthesizer, make(cfg)),
    Layer.effect(
      SpeechSynthesizer,
      Effect.map(
        make(cfg),
        (s): SpeechSynthesizerService => ({
          synthesize: (req: CommonSynthesizeRequest) =>
            s.synthesize(req as OpenAISynthesizeRequest),
          streamSynthesis: (req: CommonSynthesizeRequest) =>
            s.streamSynthesis(req as OpenAISynthesizeRequest),
          streamSynthesisFrom: s.streamSynthesisFrom,
        }),
      ),
    ),
  )
