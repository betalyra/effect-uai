import { Array as Arr, Context, Effect, Encoding, Layer, Redacted, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob, AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import * as Capabilities from "@effect-uai/core/Capabilities"
import {
  type CommonStreamSynthesizeRequest,
  type CommonSynthesizeRequest,
  SpeechSynthesizer,
  type SpeechSynthesizerService,
  TtsIncrementalText,
} from "@effect-uai/core/SpeechSynthesizer"
import { containerToTtsFormat, type MistralTtsFormat, realizedTtsFormat } from "./audioCodec.js"
import { httpStatusError, transportFailure } from "./http.js"
import type { MistralTtsModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Mistral-typed synthesize request. `model` narrows to `MistralTtsModel`;
 * `voiceId` selects a saved Voxtral voice. `refAudio` (base64 of a 2-3s clip)
 * triggers zero-shot voice cloning and takes precedence over `voiceId`.
 */
export type MistralSynthesizeRequest = Omit<CommonSynthesizeRequest, "model"> & {
  readonly model: MistralTtsModel
  readonly refAudio?: string
}

export type MistralSynthesizerService = {
  readonly synthesize: (
    request: MistralSynthesizeRequest,
  ) => Effect.Effect<AudioBlob, AiError.AiError>
  readonly streamSynthesis: (
    request: MistralSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamSynthesisFrom: <E, R>(
    textIn: Stream.Stream<string, E, R>,
    request: CommonStreamSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R>
  readonly synthesizeDialogue: SpeechSynthesizerService["synthesizeDialogue"]
  readonly streamSynthesizeDialogue: SpeechSynthesizerService["streamSynthesizeDialogue"]
}

export class MistralSynthesizer extends Context.Service<
  MistralSynthesizer,
  MistralSynthesizerService
>()("@betalyra/effect-uai/providers/mistral/MistralSynthesizer") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec — request → JSON body
// ---------------------------------------------------------------------------

const defaultFormat: AudioFormat = { container: "mp3", encoding: "mp3", sampleRate: 24000 }

type WireBody = {
  readonly model: string
  readonly input: string
  readonly response_format: MistralTtsFormat
  readonly voice_id?: string
  readonly ref_audio?: string
}

const buildBody = (
  request: MistralSynthesizeRequest,
): Effect.Effect<{ readonly body: WireBody; readonly format: AudioFormat }, AiError.AiError> =>
  Effect.gen(function* () {
    // Voxtral has no phoneme field; pronunciations are load-bearing, so reject
    // rather than silently mispronounce.
    if (request.pronunciations !== undefined && request.pronunciations.length > 0) {
      return yield* Effect.fail(
        new AiError.Unsupported({
          provider: "mistral",
          capability: "pronunciations",
          reason:
            "Voxtral TTS has no phoneme field. Use a provider with a phoneme path (Inworld, Google) for pronunciation overrides.",
        }),
      )
    }
    yield* Capabilities.warnDroppedWhen(request.speed, {
      provider: "mistral",
      capability: "speed",
      field: "speed",
      reason: "Voxtral TTS has no speed control; prosody follows the voice prompt.",
    })
    yield* Capabilities.warnDroppedWhen(request.languageCode, {
      provider: "mistral",
      capability: "languageCode",
      field: "languageCode",
      reason: "Voxtral TTS auto-detects language and clones cross-lingually.",
    })
    const responseFormat = yield* containerToTtsFormat(
      (request.outputFormat ?? defaultFormat).container,
    )
    return {
      body: {
        model: request.model,
        input: request.text,
        response_format: responseFormat,
        // Cloning clip wins over a saved voice id when both are present.
        ...(request.refAudio !== undefined
          ? { ref_audio: request.refAudio }
          : { voice_id: request.voiceId }),
      },
      format: realizedTtsFormat(responseFormat),
    }
  })

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const buildHttpRequest = (cfg: Config, body: WireBody, accept: string) =>
  HttpClientRequest.post(`${cfg.baseUrl ?? "https://api.mistral.ai"}/v1/audio/speech`).pipe(
    HttpClientRequest.bearerToken(cfg.apiKey),
    HttpClientRequest.accept(accept),
    HttpClientRequest.bodyJsonUnsafe(body),
  )

// One-shot response: base64 audio. Voxtral's streaming SSE wraps this same
// payload; since `streamSynthesisFrom` buffers the whole utterance anyway, we
// drive everything off the simpler one-shot endpoint and slice for pacing.
const WireResponse = Schema.Struct({ audio_data: Schema.String })
const decodeResponse = Schema.decodeUnknownEffect(WireResponse)

const decodeAudioData = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(new AiError.InvalidRequest({ provider: "mistral", param: "audio_data", raw: cause })),
  })

const synthesizeImpl =
  (cfg: Config) =>
  (
    request: MistralSynthesizeRequest,
  ): Effect.Effect<AudioBlob, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const { body, format } = yield* buildBody(request)
      const response = yield* client
        .execute(buildHttpRequest(cfg, body, "application/json"))
        .pipe(Effect.mapError(transportFailure))
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        yield* Effect.logWarning("[voxtral-tts] request failed", { status: response.status, body: text })
        return yield* Effect.fail(httpStatusError(response.status, text))
      }
      const json = yield* response.json.pipe(Effect.mapError(transportFailure))
      const decoded = yield* decodeResponse(json).pipe(Effect.mapError(transportFailure))
      const bytes = yield* decodeAudioData(decoded.audio_data)
      yield* Effect.logDebug("[voxtral-tts] ok", { bytes: bytes.byteLength, voice: request.voiceId })
      return { format, bytes }
    })

// ~40 ms frames so the voice loop can pace playback and cut on interrupt.
const FRAME_BYTES = 8192

const sliceIntoChunks = (bytes: Uint8Array): ReadonlyArray<AudioChunk> =>
  Arr.makeBy(Math.max(1, Math.ceil(bytes.byteLength / FRAME_BYTES)), (i) => ({
    bytes: bytes.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES),
  }))

const streamSynthesisImpl =
  (cfg: Config) =>
  (
    request: MistralSynthesizeRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError, HttpClient.HttpClient> =>
    Stream.unwrap(
      Effect.map(synthesizeImpl(cfg)(request), (blob) =>
        Stream.fromIterable(sliceIntoChunks(blob.bytes)),
      ),
    )

// ---------------------------------------------------------------------------
// Dialogue — unsupported (Voxtral has no multi-speaker endpoint)
// ---------------------------------------------------------------------------

const synthesizeDialogueUnsupported: SpeechSynthesizerService["synthesizeDialogue"] = () =>
  Effect.fail(
    new AiError.Unsupported({
      provider: "mistral",
      capability: "synthesizeDialogue",
      reason: "Voxtral TTS has no multi-speaker dialogue endpoint.",
    }),
  )

const streamSynthesizeDialogueUnsupported: SpeechSynthesizerService["streamSynthesizeDialogue"] =
  () =>
    Stream.fail(
      new AiError.Unsupported({
        provider: "mistral",
        capability: "streamSynthesizeDialogue",
        reason: "Voxtral TTS has no multi-speaker dialogue endpoint.",
      }),
    )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<MistralSynthesizerService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    synthesize: (request) =>
      synthesizeImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamSynthesis: (request) =>
      streamSynthesisImpl(cfg)(request).pipe(Stream.provideService(HttpClient.HttpClient, client)),
    // Voxtral has no incremental-text-in WS endpoint, so we fold the text
    // stream into one utterance and hand it to the chunked streaming endpoint.
    // Audio still streams out; only the text side buffers (one turn per call).
    streamSynthesisFrom: (textIn, request) =>
      Stream.unwrap(
        Effect.map(
          Stream.runFold(textIn, () => "", (acc, s) => acc + s),
          (text) =>
            streamSynthesisImpl(cfg)({ ...request, text } as MistralSynthesizeRequest).pipe(
              Stream.provideService(HttpClient.HttpClient, client),
            ),
        ),
      ),
    synthesizeDialogue: synthesizeDialogueUnsupported,
    streamSynthesizeDialogue: streamSynthesizeDialogueUnsupported,
  }))

/**
 * Layer registering `MistralSynthesizer`, the generic `SpeechSynthesizer` tag,
 * and the `TtsIncrementalText` capability marker (so `streamSynthesisFrom`
 * composes — note the text side buffers; see its docs).
 */
export const layer = (
  cfg: Config,
): Layer.Layer<
  MistralSynthesizer | SpeechSynthesizer | TtsIncrementalText,
  never,
  HttpClient.HttpClient
> =>
  Layer.mergeAll(
    Layer.effect(MistralSynthesizer, make(cfg)),
    Layer.effect(
      SpeechSynthesizer,
      Effect.map(
        make(cfg),
        (s): SpeechSynthesizerService => ({
          synthesize: (req: CommonSynthesizeRequest) =>
            s.synthesize(req as MistralSynthesizeRequest),
          streamSynthesis: (req: CommonSynthesizeRequest) =>
            s.streamSynthesis(req as MistralSynthesizeRequest),
          streamSynthesisFrom: s.streamSynthesisFrom,
          synthesizeDialogue: s.synthesizeDialogue,
          streamSynthesizeDialogue: s.streamSynthesizeDialogue,
        }),
      ),
    ),
    Layer.succeed(TtsIncrementalText, undefined),
  )
