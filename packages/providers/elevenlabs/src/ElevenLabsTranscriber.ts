import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { TranscriptResult, WordTimestamp } from "@effect-uai/core/Transcript"
import {
  type CommonTranscribeRequest,
  Transcriber,
  type TranscriberService,
} from "@effect-uai/core/Transcriber"
import { audioToBlob, defaultFileName, httpStatusError, transportFailure } from "./codec.js"
import type { ElevenLabsSttModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * ElevenLabs-typed transcribe request. `model` narrows to
 * `ElevenLabsSttModel`. `numSpeakers` hints diarization. `audioEvents`
 * surfaces `(laughter)` / `(music)` tags inline in `text` (provider
 * default: true). `fileName` overrides the multipart upload's
 * `filename`; ElevenLabs uses the extension to detect format.
 */
export type ElevenLabsTranscribeRequest = Omit<CommonTranscribeRequest, "model"> & {
  readonly model: ElevenLabsSttModel
  readonly numSpeakers?: number
  readonly audioEvents?: boolean
  readonly fileName?: string
}

export type ElevenLabsTranscriberService = {
  readonly transcribe: (
    r: ElevenLabsTranscribeRequest,
  ) => Effect.Effect<TranscriptResult, AiError.AiError>
  readonly streamTranscriptionFrom: TranscriberService["streamTranscriptionFrom"]
}

export class ElevenLabsTranscriber extends Context.Service<
  ElevenLabsTranscriber,
  ElevenLabsTranscriberService
>()("@betalyra/effect-uai/providers/elevenlabs/ElevenLabsTranscriber") {}

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const Word = Schema.Struct({
  text: Schema.String,
  start: Schema.optional(Schema.Number),
  end: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  speaker_id: Schema.optional(Schema.String),
  logprob: Schema.optional(Schema.Number),
})

const Wire = Schema.Struct({
  text: Schema.String,
  language_code: Schema.optional(Schema.String),
  language_probability: Schema.optional(Schema.Number),
  words: Schema.optional(Schema.Array(Word)),
  transcription_id: Schema.optional(Schema.String),
})
const decodeWire = Schema.decodeUnknownEffect(Wire)

const toWordTimestamp = (w: typeof Word.Type): WordTimestamp | undefined =>
  w.start === undefined || w.end === undefined
    ? undefined
    : {
        text: w.text,
        startSeconds: w.start,
        endSeconds: w.end,
        ...(w.logprob !== undefined && { confidence: Math.exp(w.logprob) }),
        ...(w.speaker_id !== undefined && { speakerId: w.speaker_id }),
      }

// ---------------------------------------------------------------------------
// Multipart body
// ---------------------------------------------------------------------------

const buildForm = (request: ElevenLabsTranscribeRequest) =>
  Effect.gen(function* () {
    const blob = yield* audioToBlob(request.audio)
    const fileName = request.fileName ?? defaultFileName(request.audio.mimeType ?? "")
    const form = new FormData()
    form.set("model_id", request.model)
    form.set("file", blob, fileName)
    if (request.language !== undefined) form.set("language_code", request.language)
    if (request.diarization !== undefined)
      form.set("diarize", request.diarization ? "true" : "false")
    if (request.wordTimestamps === true) form.set("timestamps_granularity", "word")
    if (request.numSpeakers !== undefined) form.set("num_speakers", String(request.numSpeakers))
    if (request.audioEvents !== undefined)
      form.set("tag_audio_events", request.audioEvents ? "true" : "false")
    return form
  })

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config) => cfg.baseUrl ?? "https://api.elevenlabs.io/v1"

const transcribeImpl = (cfg: Config) => (request: ElevenLabsTranscribeRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const form = yield* buildForm(request)
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/speech-to-text`).pipe(
      HttpClientRequest.setHeader("xi-api-key", Redacted.value(cfg.apiKey)),
      HttpClientRequest.bodyFormData(form),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(httpStatusError(response.status, text))
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeWire(json).pipe(
      Effect.mapError(
        (cause) => new AiError.GenerationFailed({ provider: "elevenlabs", raw: cause }),
      ),
    )
    const words = wire.words
      ?.map(toWordTimestamp)
      .filter((w): w is WordTimestamp => w !== undefined)
    return {
      text: wire.text,
      ...(wire.language_code !== undefined && { languageCode: wire.language_code }),
      ...(words !== undefined && words.length > 0 && { words }),
      raw: json,
    } satisfies TranscriptResult
  })

/**
 * ElevenLabs DOES expose `wss://api.elevenlabs.io/v1/speech-to-text/realtime`
 * with `scribe_v2_realtime`, but it's deferred to Phase 2b. This Layer
 * therefore omits `SttStreaming` — callers using
 * `Transcriber.streamTranscriptionFrom` against it get a compile-time
 * error.
 */
const unsupportedStreamFrom: TranscriberService["streamTranscriptionFrom"] = () =>
  Stream.fail(
    new AiError.Unsupported({
      provider: "elevenlabs",
      capability: "streamTranscriptionFrom",
      reason:
        "ElevenLabs realtime STT WebSocket is not wired in Phase 2a. The Layer omits `SttStreaming`; the streaming path ships in Phase 2b.",
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (cfg: Config) =>
  Effect.map(
    HttpClient.HttpClient.asEffect(),
    (client): ElevenLabsTranscriberService => ({
      transcribe: (r) =>
        transcribeImpl(cfg)(r).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      streamTranscriptionFrom: unsupportedStreamFrom,
    }),
  )

/**
 * Layer registers both `ElevenLabsTranscriber` and the generic
 * `Transcriber`. Does NOT register `SttStreaming` — realtime STT
 * WebSocket ships in Phase 2b.
 */
export const layer = (cfg: Config) =>
  Layer.merge(
    Layer.effect(ElevenLabsTranscriber, make(cfg)),
    Layer.effect(
      Transcriber,
      Effect.map(
        make(cfg),
        (s): TranscriberService => ({
          transcribe: (req: CommonTranscribeRequest) =>
            s.transcribe(req as ElevenLabsTranscribeRequest),
          streamTranscriptionFrom: s.streamTranscriptionFrom,
        }),
      ),
    ),
  )
