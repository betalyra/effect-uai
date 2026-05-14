/**
 * Sync transcription via Inworld's REST endpoint.
 *
 * - `transcribe` → `POST /stt/v1/transcribe` with audio as base64 in
 *   `audioData.content`. URL input is not accepted by Inworld — the
 *   adapter rejects `_tag: "url"` audio sources with `InvalidRequest`.
 *
 * Streaming transcription lives at the `InworldRealtimeTranscriber`
 * subpath, which adds the WS path and the `SttStreaming` capability marker.
 */
import { Context, Effect, Encoding, Layer, Match, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioSource } from "@effect-uai/core/Audio"
import type { TranscriptEvent, TranscriptResult, WordTimestamp } from "@effect-uai/core/Transcript"
import {
  type CommonStreamTranscribeRequest,
  type CommonTranscribeRequest,
  Transcriber,
  type TranscriberService,
} from "@effect-uai/core/Transcriber"
import { authHeader, httpStatusError, transportFailure } from "./codec.js"
import type { InworldSttModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inworld-typed transcribe request. `numberOfChannels` defaults to 1.
 * `audioEncoding` is autodetected from the audio MIME by default; pass
 * an explicit value to override (useful for raw PCM bytes).
 */
export type InworldTranscribeRequest = Omit<CommonTranscribeRequest, "model"> & {
  readonly model: InworldSttModel
  readonly audioEncoding?: "AUTO_DETECT" | "LINEAR16" | "MP3" | "OGG_OPUS" | "FLAC"
  readonly sampleRateHertz?: number
  readonly numberOfChannels?: number
}

export type InworldTranscriberService = {
  readonly transcribe: (
    r: InworldTranscribeRequest,
  ) => Effect.Effect<TranscriptResult, AiError.AiError>
  readonly streamTranscriptionFrom: TranscriberService["streamTranscriptionFrom"]
}

export class InworldTranscriber extends Context.Service<
  InworldTranscriber,
  InworldTranscriberService
>()("@betalyra/effect-uai/providers/inworld/InworldTranscriber") {}

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

// ---------------------------------------------------------------------------
// AudioSource → base64. Inworld's sync endpoint takes inline base64 only.
// ---------------------------------------------------------------------------

const urlNotSupported: AiError.AiError = new AiError.InvalidRequest({
  provider: "inworld",
  param: "audio",
  raw: 'Inworld accepts only inline base64. Fetch the URL yourself and pass `{ _tag: "bytes", bytes, mimeType }`.',
})

const audioToBase64: (audio: AudioSource) => Effect.Effect<string, AiError.AiError> =
  Match.type<AudioSource>().pipe(
    Match.tag("bytes", (a) => Effect.succeed(Encoding.encodeBase64(a.bytes))),
    Match.tag("base64", (a) => Effect.succeed(a.base64)),
    Match.tag("url", () => Effect.fail(urlNotSupported)),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const promptToTerms = (
  prompt: string | { readonly terms: ReadonlyArray<string> } | undefined,
): ReadonlyArray<string> | undefined =>
  prompt === undefined ? undefined : typeof prompt === "string" ? [prompt] : prompt.terms

const buildBody = (request: InworldTranscribeRequest) =>
  Effect.gen(function* () {
    const content = yield* audioToBase64(request.audio)
    const prompts = promptToTerms(request.prompt)
    return {
      transcribeConfig: {
        modelId: request.model,
        audioEncoding: request.audioEncoding ?? "AUTO_DETECT",
        ...(request.sampleRateHertz !== undefined && {
          sampleRateHertz: request.sampleRateHertz,
        }),
        numberOfChannels: request.numberOfChannels ?? 1,
        ...(request.language !== undefined && { language: request.language }),
        ...(prompts !== undefined && { prompts }),
        ...(request.wordTimestamps === true && { includeWordTimestamps: true }),
      },
      audioData: { content },
    }
  })

// ---------------------------------------------------------------------------
// Wire schema
// ---------------------------------------------------------------------------

const WireWord = Schema.Struct({
  word: Schema.String,
  startTimeMs: Schema.optional(Schema.Number),
  endTimeMs: Schema.optional(Schema.Number),
  confidence: Schema.optional(Schema.Number),
})

const WireResponse = Schema.Struct({
  transcription: Schema.Struct({
    transcript: Schema.String,
    isFinal: Schema.optional(Schema.Boolean),
    wordTimestamps: Schema.optional(Schema.NullOr(Schema.Array(WireWord))),
  }),
})
const decodeResponse = Schema.decodeUnknownEffect(WireResponse)

const wireWordToCommon = (w: typeof WireWord.Type): WordTimestamp | undefined =>
  w.startTimeMs === undefined || w.endTimeMs === undefined
    ? undefined
    : {
        text: w.word,
        startSeconds: w.startTimeMs / 1000,
        endSeconds: w.endTimeMs / 1000,
        ...(w.confidence !== undefined && { confidence: w.confidence }),
      }

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config) => cfg.baseUrl ?? "https://api.inworld.ai"

/** Exported for reuse by `InworldRealtimeTranscriber`. */
export const transcribeImpl = (cfg: Config) => (request: InworldTranscribeRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* buildBody(request)
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/stt/v1/transcribe`).pipe(
      HttpClientRequest.setHeader("Authorization", authHeader(cfg.apiKey)),
      HttpClientRequest.bodyJsonUnsafe(body),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(httpStatusError(response.status, text))
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeResponse(json).pipe(
      Effect.mapError(
        (cause) =>
          new AiError.GenerationFailed({
            provider: "inworld",
            raw: { message: "STT response missing `transcription.transcript`", cause, json },
          }),
      ),
    )
    const words = wire.transcription.wordTimestamps
      ?.map(wireWordToCommon)
      .filter((w): w is WordTimestamp => w !== undefined)
    return {
      text: wire.transcription.transcript,
      ...(words !== undefined && words.length > 0 && { words }),
      raw: json,
    } satisfies TranscriptResult
  })

// ---------------------------------------------------------------------------
// streamTranscriptionFrom Unsupported on this Layer
// ---------------------------------------------------------------------------

const streamUnsupported = <E, R>(
  _audioIn: Stream.Stream<Uint8Array, E, R>,
  _request: CommonStreamTranscribeRequest,
): Stream.Stream<TranscriptEvent, AiError.AiError | E, R> => {
  const fail: Stream.Stream<TranscriptEvent, AiError.AiError | E, R> = Stream.fail(
    new AiError.Unsupported({
      provider: "inworld",
      capability: "streamTranscriptionFrom",
      reason:
        "This Layer is sync-only. Import `@effect-uai/inworld/InworldRealtimeTranscriber` to use the WS streamTranscriptionFrom path.",
    }),
  )
  return fail
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<InworldTranscriberService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    transcribe: (request) =>
      transcribeImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamTranscriptionFrom: streamUnsupported,
  }))

/**
 * Sync-only Layer. Registers `InworldTranscriber` + the generic
 * `Transcriber`. Does **not** register `SttStreaming` — for live
 * transcription use `@effect-uai/inworld/InworldRealtimeTranscriber`.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<InworldTranscriber | Transcriber, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(InworldTranscriber, make(cfg)),
    Layer.effect(
      Transcriber,
      Effect.map(
        make(cfg),
        (s): TranscriberService => ({
          transcribe: (req: CommonTranscribeRequest) =>
            s.transcribe(req as InworldTranscribeRequest),
          streamTranscriptionFrom: s.streamTranscriptionFrom,
        }),
      ),
    ),
  )
