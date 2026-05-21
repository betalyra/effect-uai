import { Context, Effect, Layer, Match, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { TranscriptEvent, TranscriptResult, WordTimestamp } from "@effect-uai/core/Transcript"
import {
  type CommonStreamTranscribeRequest,
  type CommonTranscribeRequest,
  Transcriber,
  type TranscriberService,
} from "@effect-uai/core/Transcriber"
import { audioToBlob, defaultFileName, httpStatusError, transportFailure } from "./codec.js"
import type { OpenAITranscribeModel } from "./models.js"
import { type OpenAiRegion, resolveHost } from "./region.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * OpenAI-typed transcribe request. `model` narrows to the typed
 * `OpenAITranscribeModel` union; `fileName` overrides the multipart
 * upload's `filename` (OpenAI uses the extension to detect format).
 *
 * Field caveats:
 * - `wordTimestamps` requires `whisper-1`. GPT-4o models don't return
 *   per-word timing; combining them with `wordTimestamps: true` fails
 *   with `AiError.Unsupported`.
 * - `diarization` is narrowed out — OpenAI's transcription endpoint
 *   has no speaker diarization. The generic `Transcriber` Layer still
 *   accepts the wider `CommonTranscribeRequest`; setting `diarization`
 *   there fails with `AiError.Unsupported` at the Layer adapter.
 */
export type OpenAITranscribeRequest = Omit<
  CommonTranscribeRequest,
  "model" | "diarization"
> & {
  readonly model: OpenAITranscribeModel
  readonly temperature?: number
  readonly fileName?: string
}

export type OpenAITranscriberService = {
  readonly transcribe: (
    request: OpenAITranscribeRequest,
  ) => Effect.Effect<TranscriptResult, AiError.AiError>
  readonly streamTranscriptionFrom: <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ) => Stream.Stream<TranscriptEvent, AiError.AiError | E, R>
}

export class OpenAITranscriber extends Context.Service<
  OpenAITranscriber,
  OpenAITranscriberService
>()("@betalyra/effect-uai/providers/openai/OpenAITranscriber") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: OpenAiRegion
}

// ---------------------------------------------------------------------------
// Codec — prompt collapse
// ---------------------------------------------------------------------------

/**
 * OpenAI takes `prompt` as a single string. Collapse `{ terms }` to a
 * comma-separated hint; OpenAI uses it as style/context, not strict
 * vocab biasing.
 */
const promptToString: (prompt: string | { readonly terms: ReadonlyArray<string> }) => string =
  Match.type<string | { readonly terms: ReadonlyArray<string> }>().pipe(
    Match.when(Match.string, (s) => s),
    Match.orElse(({ terms }) => terms.join(", ")),
  )

// ---------------------------------------------------------------------------
// Codec — request → FormData
// ---------------------------------------------------------------------------

const wantsVerboseJson = (request: OpenAITranscribeRequest): boolean =>
  request.wordTimestamps === true

/**
 * Typed-path guard: gates `wordTimestamps × model` (row D data-dependent
 * gap — wordTimestamps stays on the typed request because it works for
 * `whisper-1`).
 */
const guardCapabilities = (
  request: OpenAITranscribeRequest,
): Effect.Effect<void, AiError.AiError> => {
  if (wantsVerboseJson(request) && request.model !== "whisper-1") {
    return Effect.fail(
      new AiError.Unsupported({
        provider: "openai",
        capability: "wordTimestamps",
        reason: `wordTimestamps requires model "whisper-1"; got "${request.model}". OpenAI's GPT-4o transcribe models do not return per-word timing.`,
      }),
    )
  }
  return Effect.void
}

/**
 * Generic-Layer guard: `diarization` is narrowed out of the typed
 * request, but generic callers can still pass it via
 * `CommonTranscribeRequest`. Reject at the adapter boundary.
 */
const guardGenericCapabilities = (
  request: CommonTranscribeRequest,
): Effect.Effect<void, AiError.AiError> => {
  if (request.diarization === true) {
    return Effect.fail(
      new AiError.Unsupported({
        provider: "openai",
        capability: "diarization",
        reason: "OpenAI's transcription endpoint does not offer speaker diarization.",
      }),
    )
  }
  return Effect.void
}

const buildFormData = (
  request: OpenAITranscribeRequest,
): Effect.Effect<FormData, AiError.AiError> =>
  Effect.gen(function* () {
    yield* guardCapabilities(request)
    const blob = yield* audioToBlob(request.audio)
    const fd = new FormData()
    fd.set("file", blob, request.fileName ?? defaultFileName(blob.type))
    fd.set("model", request.model)
    fd.set("response_format", wantsVerboseJson(request) ? "verbose_json" : "json")
    if (wantsVerboseJson(request)) fd.set("timestamp_granularities[]", "word")
    if (request.language !== undefined) fd.set("language", request.language)
    if (request.prompt !== undefined) fd.set("prompt", promptToString(request.prompt))
    if (request.temperature !== undefined) fd.set("temperature", String(request.temperature))
    return fd
  })

// ---------------------------------------------------------------------------
// Codec — response → TranscriptResult
// ---------------------------------------------------------------------------

const WireWord = Schema.Struct({
  word: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
})

const WireVerboseResponse = Schema.Struct({
  text: Schema.String,
  language: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.Number),
  words: Schema.optional(Schema.Array(WireWord)),
})

const WireSimpleResponse = Schema.Struct({ text: Schema.String })

const decodeVerbose = Schema.decodeUnknownEffect(WireVerboseResponse)
const decodeSimple = Schema.decodeUnknownEffect(WireSimpleResponse)

const wireWordToCommon = (w: typeof WireWord.Type): WordTimestamp => ({
  text: w.word,
  startSeconds: w.start,
  endSeconds: w.end,
})

const verboseToResult = (
  raw: unknown,
  decoded: typeof WireVerboseResponse.Type,
): TranscriptResult => ({
  text: decoded.text,
  ...(decoded.language !== undefined && { languageCode: decoded.language }),
  ...(decoded.duration !== undefined && { durationSeconds: decoded.duration }),
  ...(decoded.words !== undefined && { words: decoded.words.map(wireWordToCommon) }),
  raw,
})

const decodeResponse = (
  request: OpenAITranscribeRequest,
  raw: unknown,
): Effect.Effect<TranscriptResult, AiError.AiError> =>
  wantsVerboseJson(request)
    ? decodeVerbose(raw).pipe(
        Effect.mapError(transportFailure),
        Effect.map((decoded) => verboseToResult(raw, decoded)),
      )
    : decodeSimple(raw).pipe(
        Effect.mapError(transportFailure),
        Effect.map((decoded): TranscriptResult => ({ text: decoded.text, raw })),
      )

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** Exported for reuse by `OpenAIRealtimeTranscriber` (same sync path). */
export const transcribeImpl =
  (cfg: Config) =>
  (
    request: OpenAITranscribeRequest,
  ): Effect.Effect<TranscriptResult, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const formData = yield* buildFormData(request)
      const httpRequest = HttpClientRequest.post(`${resolveHost(cfg)}/audio/transcriptions`).pipe(
        HttpClientRequest.bearerToken(cfg.apiKey),
        HttpClientRequest.bodyFormData(formData),
      )
      const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.fail(httpStatusError(response.status, text))
      }
      const json = yield* response.json.pipe(Effect.mapError(transportFailure))
      return yield* decodeResponse(request, json)
    })

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

/**
 * Sync-only Layer's streaming impl. For live transcription, import the
 * `OpenAIRealtimeTranscriber` subpath instead — it registers `SttStreaming`
 * and wires the Realtime WS endpoint. Provided here so the sync Layer can
 * still satisfy the `TranscriberService` shape; the marker absence makes
 * `Transcriber.streamTranscriptionFrom` calls a compile-time error against
 * this Layer alone.
 */
const streamUnsupported = <E, R>(
  _audioIn: Stream.Stream<Uint8Array, E, R>,
  _request: CommonStreamTranscribeRequest,
): Stream.Stream<TranscriptEvent, AiError.AiError | E, R> => {
  const fail: Stream.Stream<TranscriptEvent, AiError.AiError | E, R> = Stream.fail(
    new AiError.Unsupported({
      provider: "openai",
      capability: "streamTranscriptionFrom",
      reason:
        "OpenAI Realtime WebSocket streaming is not yet wired in this package. Use `transcribe` for sync transcription.",
    }),
  )
  return fail
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<OpenAITranscriberService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    transcribe: (request) =>
      transcribeImpl(cfg)(request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamTranscriptionFrom: streamUnsupported,
  }))

/**
 * Sync-only Layer. Registers `OpenAITranscriber` + the generic `Transcriber`
 * tag. Does **not** register the `SttStreaming` capability marker — for
 * live transcription use `@effect-uai/openai/OpenAIRealtimeTranscriber`,
 * which uses the Realtime WS endpoint and the `ws` peer dep.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<OpenAITranscriber | Transcriber, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(OpenAITranscriber, make(cfg)),
    Layer.effect(
      Transcriber,
      Effect.map(
        make(cfg),
        (s): TranscriberService => ({
          transcribe: (req: CommonTranscribeRequest) =>
            Effect.flatMap(guardGenericCapabilities(req), () =>
              s.transcribe(req as OpenAITranscribeRequest),
            ),
          streamTranscriptionFrom: s.streamTranscriptionFrom,
        }),
      ),
    ),
  )
