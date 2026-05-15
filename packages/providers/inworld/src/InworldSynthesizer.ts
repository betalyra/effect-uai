/**
 * Sync + chunked-HTTP TTS via Inworld's REST endpoints.
 *
 * - `synthesize` → `POST /tts/v1/voice` (JSON body, single base64 audio in
 *   response).
 * - `streamSynthesis` → `POST /tts/v1/voice:stream` (NDJSON response, one
 *   JSON object per line, each carrying a base64 audio chunk).
 *
 * Incremental text-in (`streamSynthesisFrom`) lives at the
 * `InworldRealtimeSynthesizer` subpath, which adds the WS path and the
 * `TtsIncrementalText` capability marker.
 */
import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob, AudioChunk } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import {
  type CommonStreamSynthesizeRequest,
  type CommonSynthesizeRequest,
  SpeechSynthesizer,
  type SpeechSynthesizerService,
} from "@effect-uai/core/SpeechSynthesizer"
import {
  audioConfigFor,
  authHeader,
  decodeAudioContent,
  defaultFormat,
  httpStatusError,
  transportFailure,
} from "./codec.js"
import type { InworldDeliveryMode, InworldTtsModel, InworldVoiceId } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inworld-typed synthesize request.
 *
 * - `deliveryMode` only honored by `inworld-tts-2` (`STABLE` / `BALANCED` /
 *   `CREATIVE` — older models ignore it).
 * - `temperature` valid range is `(0, 2]` per docs.
 * - `applyTextNormalization` defaults to `ON`; pass `"OFF"` to feed the
 *   model raw text (faster, but punctuation pacing is on you).
 */
export type InworldSynthesizeRequest = Omit<CommonSynthesizeRequest, "model" | "voiceId"> & {
  readonly model: InworldTtsModel
  readonly voiceId: InworldVoiceId
  readonly temperature?: number
  readonly deliveryMode?: InworldDeliveryMode
  readonly applyTextNormalization?: "ON" | "OFF"
}

export type InworldSynthesizerService = {
  readonly synthesize: (r: InworldSynthesizeRequest) => Effect.Effect<AudioBlob, AiError.AiError>
  readonly streamSynthesis: (
    r: InworldSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamSynthesisFrom: SpeechSynthesizerService["streamSynthesisFrom"]
}

export class InworldSynthesizer extends Context.Service<
  InworldSynthesizer,
  InworldSynthesizerService
>()("@betalyra/effect-uai/providers/inworld/InworldSynthesizer") {}

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/** Exported for reuse by the realtime variant's BOS `create` frame. */
export const buildBody = (r: InworldSynthesizeRequest) =>
  Effect.gen(function* () {
    const format = r.outputFormat ?? defaultFormat
    const audioConfig = yield* audioConfigFor(format, r.speed)
    const body = {
      text: r.text,
      voiceId: r.voiceId,
      modelId: r.model,
      audioConfig,
      ...(r.languageCode !== undefined && { language: r.languageCode }),
      ...(r.deliveryMode !== undefined && { deliveryMode: r.deliveryMode }),
      ...(r.temperature !== undefined && { temperature: r.temperature }),
      ...(r.applyTextNormalization !== undefined && {
        applyTextNormalization: r.applyTextNormalization,
      }),
    }
    return { body, format }
  })

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const SyncResponse = Schema.Struct({ audioContent: Schema.String })
const decodeSyncResponse = Schema.decodeUnknownEffect(SyncResponse)

const StreamLine = Schema.Struct({
  result: Schema.optional(Schema.Struct({ audioContent: Schema.optional(Schema.String) })),
  error: Schema.optional(Schema.Unknown),
})

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config) => cfg.baseUrl ?? "https://api.inworld.ai"

const buildRequest = (cfg: Config, path: "/tts/v1/voice" | "/tts/v1/voice:stream", body: unknown) =>
  HttpClientRequest.post(`${baseUrl(cfg)}${path}`).pipe(
    HttpClientRequest.setHeader("Authorization", authHeader(cfg.apiKey)),
    HttpClientRequest.bodyJsonUnsafe(body),
  )

/** Exported for reuse by `InworldRealtimeSynthesizer`. */
export const synthesizeImpl = (cfg: Config) => (request: InworldSynthesizeRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const { body, format } = yield* buildBody(request)
    const httpRequest = buildRequest(cfg, "/tts/v1/voice", body)
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(httpStatusError(response.status, text))
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeSyncResponse(json).pipe(
      Effect.mapError(
        (cause) =>
          new AiError.GenerationFailed({
            provider: "inworld",
            raw: { message: "sync TTS response missing `audioContent`", cause, json },
          }),
      ),
    )
    const bytes = yield* decodeAudioContent(wire.audioContent)
    return { format, bytes } satisfies AudioBlob
  })

const lineToStream = (line: typeof StreamLine.Type): Stream.Stream<AudioChunk, AiError.AiError> => {
  if (line.error !== undefined) {
    return Stream.fail(new AiError.GenerationFailed({ provider: "inworld", raw: line.error }))
  }
  const b64 = line.result?.audioContent
  if (b64 === undefined) return Stream.empty
  return Stream.fromEffect(
    decodeAudioContent(b64).pipe(Effect.map((bytes): AudioChunk => ({ bytes }))),
  )
}

/** Exported for reuse by `InworldRealtimeSynthesizer`. */
export const streamSynthesisImpl = (cfg: Config) => (request: InworldSynthesizeRequest) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const { body } = yield* buildBody(request)
      const httpRequest = buildRequest(cfg, "/tts/v1/voice:stream", body)
      const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return Stream.fail(httpStatusError(response.status, text))
      }
      return response.stream.pipe(
        Stream.mapError(transportFailure),
        JSONL.fromBytes,
        JSONL.parse(StreamLine),
        Stream.mapError(
          (cause): AiError.AiError =>
            new AiError.GenerationFailed({
              provider: "inworld",
              raw: { message: "NDJSON parse failed", cause },
            }),
        ),
        Stream.flatMap(lineToStream),
      )
    }),
  )

const streamUnsupported = <E, R>(
  _textIn: Stream.Stream<string, E, R>,
  _request: CommonStreamSynthesizeRequest,
): Stream.Stream<AudioChunk, AiError.AiError | E, R> => {
  const fail: Stream.Stream<AudioChunk, AiError.AiError | E, R> = Stream.fail(
    new AiError.Unsupported({
      provider: "inworld",
      capability: "streamSynthesisFrom",
      reason:
        "This Layer is sync-only. Import `@effect-uai/inworld/InworldRealtimeSynthesizer` to use the WS streamSynthesisFrom path.",
    }),
  )
  return fail
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<InworldSynthesizerService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient.asEffect(), (client) => ({
    synthesize: (r) =>
      synthesizeImpl(cfg)(r).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    streamSynthesis: (r) =>
      streamSynthesisImpl(cfg)(r).pipe(Stream.provideService(HttpClient.HttpClient, client)),
    streamSynthesisFrom: streamUnsupported,
  }))

/**
 * Sync-only Layer. Registers `InworldSynthesizer` + the generic
 * `SpeechSynthesizer`. Does **not** register `TtsIncrementalText` — for
 * incremental text-in use `@effect-uai/inworld/InworldRealtimeSynthesizer`.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<InworldSynthesizer | SpeechSynthesizer, never, HttpClient.HttpClient> =>
  Layer.merge(
    Layer.effect(InworldSynthesizer, make(cfg)),
    Layer.effect(
      SpeechSynthesizer,
      Effect.map(
        make(cfg),
        (s): SpeechSynthesizerService => ({
          synthesize: (req: CommonSynthesizeRequest) =>
            s.synthesize(req as InworldSynthesizeRequest),
          streamSynthesis: (req: CommonSynthesizeRequest) =>
            s.streamSynthesis(req as InworldSynthesizeRequest),
          streamSynthesisFrom: s.streamSynthesisFrom,
        }),
      ),
    ),
  )
