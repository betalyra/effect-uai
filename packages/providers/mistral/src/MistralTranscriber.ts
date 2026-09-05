import { Array as Arr, Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import { isAudioUrl } from "@effect-uai/core/Audio"
import type { TranscriptEvent, TranscriptResult, WordTimestamp } from "@effect-uai/core/Transcript"
import {
  type CommonStreamTranscribeRequest,
  type CommonTranscribeRequest,
  Transcriber,
  type TranscriberService,
} from "@effect-uai/core/Transcriber"
import { audioToBlob, defaultFileName } from "./audioCodec.js"
import { bodyMultipart, httpStatusError, transportFailure } from "./http.js"
import type { MistralTranscribeModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Mistral-typed transcribe request. `model` narrows to the typed
 * `MistralTranscribeModel` union; `fileName` overrides the multipart upload's
 * filename. Voxtral's batch endpoint supports diarization, word timestamps,
 * and context biasing.
 */
export type MistralTranscribeRequest = Omit<CommonTranscribeRequest, "model"> & {
  readonly model: MistralTranscribeModel
  readonly temperature?: number
  readonly fileName?: string
}

export type MistralTranscriberService = {
  readonly transcribe: (
    request: MistralTranscribeRequest,
  ) => Effect.Effect<TranscriptResult, AiError.AiError>
  readonly streamTranscriptionFrom: <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ) => Stream.Stream<TranscriptEvent, AiError.AiError | E, R>
}

export class MistralTranscriber extends Context.Service<
  MistralTranscriber,
  MistralTranscriberService
>()("@betalyra/effect-uai/providers/mistral/MistralTranscriber") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec — request → FormData
//
// Each field is described as a data `Part`, then the whole list is folded into
// one FormData. A `Part` is either a scalar field or a file field (with an
// upload filename).
// ---------------------------------------------------------------------------

type Part =
  | readonly [name: string, value: string]
  | readonly [name: string, file: Blob, filename: string]

const when = (condition: boolean, part: Part): ReadonlyArray<Part> => (condition ? [part] : [])

const appendPart = (fd: FormData, part: Part): FormData => {
  if (part.length === 3) fd.append(part[0], part[1], part[2])
  else fd.append(part[0], part[1])
  return fd
}

const buildFormData = (
  request: MistralTranscribeRequest,
): Effect.Effect<FormData, AiError.AiError> =>
  Effect.gen(function* () {
    // Voxtral transcription has no Whisper-style prose `prompt` field.
    yield* Capabilities.warnDroppedWhen(request.prompt, {
      provider: "mistral",
      capability: "prompt",
      field: "prompt",
      reason:
        "Voxtral transcription has no prose prompt field; use `biasingTerms` for vocabulary hints.",
    })
    // URL audio rides the `file_url` field; inline bytes/base64 upload directly.
    const filePart: Part = isAudioUrl(request.audio)
      ? ["file_url", request.audio.url]
      : yield* audioToBlob(request.audio).pipe(
          Effect.map((blob): Part => [
            "file",
            blob,
            request.fileName ?? defaultFileName(blob.type),
          ]),
        )
    const parts: ReadonlyArray<Part> = [
      filePart,
      ["model", request.model],
      ...when(request.language !== undefined, ["language", request.language ?? ""]),
      ...when(request.diarization === true, ["diarize", "true"]),
      ...when(request.wordTimestamps === true, ["timestamp_granularities[]", "word"]),
      ...when(request.temperature !== undefined, ["temperature", String(request.temperature)]),
      // Voxtral biases on a `context_bias` term list; one entry per term.
      ...(request.biasingTerms ?? []).map((term): Part => ["context_bias", term]),
    ]
    return Arr.reduce(parts, new FormData(), appendPart)
  })

// ---------------------------------------------------------------------------
// Codec — response → TranscriptResult
// ---------------------------------------------------------------------------

const WireWord = Schema.Struct({
  text: Schema.optional(Schema.String),
  word: Schema.optional(Schema.String),
  start: Schema.Number,
  end: Schema.Number,
  speaker: Schema.optional(Schema.NullOr(Schema.String)),
})

const WireResponse = Schema.Struct({
  text: Schema.String,
  language: Schema.optional(Schema.NullOr(Schema.String)),
  words: Schema.optional(Schema.NullOr(Schema.Array(WireWord))),
})

const decodeResponse = Schema.decodeUnknownEffect(WireResponse)

const wireWordToCommon = (w: typeof WireWord.Type): WordTimestamp => ({
  text: w.text ?? w.word ?? "",
  startSeconds: w.start,
  endSeconds: w.end,
  ...(w.speaker != null && { speakerId: w.speaker }),
})

const toResult = (raw: unknown, decoded: typeof WireResponse.Type): TranscriptResult => ({
  text: decoded.text,
  ...(decoded.language != null && { languageCode: decoded.language }),
  ...(decoded.words != null && { words: decoded.words.map(wireWordToCommon) }),
  raw,
})

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** Exported for reuse by `MistralRealtimeTranscriber` (same sync path). */
export const transcribeImpl =
  (cfg: Config) =>
  (
    request: MistralTranscribeRequest,
  ): Effect.Effect<TranscriptResult, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const baseUrl = cfg.baseUrl ?? "https://api.mistral.ai"
      const withBody = yield* Effect.flatMap(buildFormData(request), bodyMultipart)
      const httpRequest = HttpClientRequest.post(`${baseUrl}/v1/audio/transcriptions`).pipe(
        HttpClientRequest.bearerToken(cfg.apiKey),
        withBody,
      )
      const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.fail(httpStatusError(response.status, text))
      }
      const json = yield* response.json.pipe(Effect.mapError(transportFailure))
      const decoded = yield* decodeResponse(json).pipe(Effect.mapError(transportFailure))
      return toResult(json, decoded)
    })

// ---------------------------------------------------------------------------
// streamTranscriptionFrom — Unsupported on the sync-only Layer
// ---------------------------------------------------------------------------

/**
 * Sync-only Layer's streaming impl. For live transcription import the
 * `MistralRealtimeTranscriber` subpath, which registers `SttStreaming` and
 * wires the Voxtral Realtime WebSocket endpoint.
 */
const streamUnsupported = <E, R>(
  _audioIn: Stream.Stream<Uint8Array, E, R>,
  _request: CommonStreamTranscribeRequest,
): Stream.Stream<TranscriptEvent, AiError.AiError | E, R> =>
  Stream.fail(
    new AiError.Unsupported({
      provider: "mistral",
      capability: "streamTranscriptionFrom",
      reason:
        "This Layer is sync-only. Use `@effect-uai/mistral/MistralRealtimeTranscriber` for live Voxtral transcription.",
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<MistralTranscriberService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => ({
    transcribe: (request) =>
      transcribeImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamTranscriptionFrom: streamUnsupported,
  }))

/**
 * Sync-only Layer. Registers `MistralTranscriber` + the generic `Transcriber`
 * tag. Does NOT register `SttStreaming` — for live transcription use
 * `@effect-uai/mistral/MistralRealtimeTranscriber`.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<MistralTranscriber | Transcriber, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(MistralTranscriber, make(cfg)),
    Layer.effect(
      Transcriber,
      Effect.map(make(cfg), (s): TranscriberService => ({
        transcribe: (req: CommonTranscribeRequest) => s.transcribe(req as MistralTranscribeRequest),
        streamTranscriptionFrom: s.streamTranscriptionFrom,
      })),
    ),
  )
