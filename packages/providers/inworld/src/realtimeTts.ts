/**
 * Inworld Realtime TTS — `wss://api.inworld.ai/tts/v1/voice:streamBidirectional`.
 *
 * Auth: `Authorization: Basic <API_KEY>` on the WS upgrade header (matches
 * Inworld's own JS sample). The docs mention a `?Authorization=…` query
 * variant but the server rejects it in practice. Setting headers needs the
 * `ws` peer dep (Node/Bun); see `./wsAuth.ts`.
 *
 * Wire shape (single-context per call):
 *   client → server:
 *     `{ "create": { voiceId, modelId, audioConfig, ... } }`
 *     `{ "send_text": { "text": "..." } }`             (repeated)
 *     `{ "close_context": {} }`                        (text stream end)
 *   server → client:
 *     `{ "result": { "contextCreated": {...} } }`      (handshake ack)
 *     `{ "result": { "audioChunk": { "audioContent": "<b64>" } } }` (×N)
 *     `{ "result": { "contextClosed": {...} } }`       (final)
 *
 * Multi-context (`contextId`) is not surfaced here — one logical
 * utterance per call.
 */
import { Effect, Queue, Redacted, Schema, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import { audioConfigFor, decodeAudioContent, defaultFormat } from "./codec.js"
import type { InworldDeliveryMode, InworldTtsModel, InworldVoiceId } from "./models.js"
import { authedWsConstructor } from "./wsAuth.js"

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

/**
 * Incremental-text-in request. Mirrors the sync request minus `text` (which
 * comes from the input stream).
 */
export type StreamSynthesizeRequest = {
  readonly model: InworldTtsModel
  readonly voiceId: InworldVoiceId
  readonly outputFormat?: AudioFormat
  readonly languageCode?: string
  readonly temperature?: number
  readonly deliveryMode?: InworldDeliveryMode
  readonly applyTextNormalization?: "ON" | "OFF"
  readonly speed?: number
}

// ---------------------------------------------------------------------------
// URL + frame builders
// ---------------------------------------------------------------------------

export const buildWsUrl = (cfg: Config) => {
  const wsBase = (cfg.baseUrl ?? "https://api.inworld.ai").replace(/^http/, "ws")
  return `${wsBase}/tts/v1/voice:streamBidirectional`
}

// TTS WS uses snake_case outbound (per Inworld's own JS sample). The
// camelCase helper from `codec.ts` is built for the REST/JSON sync paths;
// rewire the field names here for the WS path. Server responses come back
// camelCase regardless — see `ResultBody` below.
const audioConfigSnake = (request: StreamSynthesizeRequest) =>
  Effect.map(audioConfigFor(request.outputFormat ?? defaultFormat, request.speed), (cfg) => ({
    audio_encoding: cfg.audioEncoding,
    ...(cfg.sampleRateHertz !== undefined && { sample_rate_hertz: cfg.sampleRateHertz }),
    ...(cfg.bitRate !== undefined && { bit_rate: cfg.bitRate }),
    ...(cfg.speakingRate !== undefined && { speaking_rate: cfg.speakingRate }),
  }))

const createFrame = (request: StreamSynthesizeRequest) =>
  Effect.map(audioConfigSnake(request), (audio_config) =>
    JSON.stringify({
      create: {
        voice_id: request.voiceId,
        model_id: request.model,
        audio_config,
        ...(request.languageCode !== undefined && { language: request.languageCode }),
        ...(request.deliveryMode !== undefined && { delivery_mode: request.deliveryMode }),
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.applyTextNormalization !== undefined && {
          apply_text_normalization: request.applyTextNormalization,
        }),
      },
    }),
  )

// `flush_context: {}` inside `send_text` nudges the server to flush
// pending audio promptly — matches the low-latency sample.
const sendTextFrame = (text: string) => JSON.stringify({ send_text: { text, flush_context: {} } })
const closeContextFrame = JSON.stringify({ close_context: {} })

// ---------------------------------------------------------------------------
// Wire schema (server → client)
// ---------------------------------------------------------------------------

const ResultBody = Schema.Struct({
  audioChunk: Schema.optional(Schema.Struct({ audioContent: Schema.String })),
  contextCreated: Schema.optional(Schema.Unknown),
  flushCompleted: Schema.optional(Schema.Unknown),
  contextClosed: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Unknown),
})

const ServerFrame = Schema.Struct({
  result: Schema.optional(ResultBody),
  error: Schema.optional(Schema.Unknown),
})
const decodeServerFrame = Schema.decodeUnknownEffect(ServerFrame)

const handleServerFrame = (queue: Queue.Queue<AudioChunk>) => (raw: string) =>
  Effect.gen(function* () {
    const json = yield* JSONL.parseSafe(raw)
    if (json === undefined) return
    const decoded = yield* decodeServerFrame(json).pipe(Effect.option)
    if (decoded._tag === "None") return
    const frame = decoded.value
    if (frame.error !== undefined) {
      yield* Effect.logWarning("[inworld-tts] server error frame", { error: frame.error })
      return
    }
    const audio = frame.result?.audioChunk?.audioContent
    if (audio === undefined || audio === "") return
    const bytes = yield* decodeAudioContent(audio).pipe(Effect.option)
    if (bytes._tag === "Some") yield* Queue.offer(queue, { bytes: bytes.value })
  })

// ---------------------------------------------------------------------------
// Stream<string> → Stream<AudioChunk>
// ---------------------------------------------------------------------------

export const streamSynthesis =
  (cfg: Config) =>
  <E, R>(
    textIn: Stream.Stream<string, E, R>,
    request: StreamSynthesizeRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError | E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const create = yield* createFrame(request)
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg)).pipe(
          Effect.provideService(Socket.WebSocketConstructor, authedWsConstructor(cfg.apiKey)),
        )
        const queue = yield* Queue.bounded<AudioChunk>(64)
        const write = yield* socket.writer

        // Writer: BOS `create` → drain text as `send_text` → `close_context`.
        // The reader fiber surfaces the remaining audio drained by the server
        // post-close and shuts the queue when the WS upstream closes.
        yield* Effect.gen(function* () {
          yield* write(create)
          yield* Stream.runForEach(textIn, (text) =>
            text.length === 0 ? Effect.void : write(sendTextFrame(text)),
          )
          yield* write(closeContextFrame)
        }).pipe(Effect.ignore, Effect.forkScoped)

        yield* socket
          .runString(handleServerFrame(queue))
          .pipe(Effect.ensuring(Queue.shutdown(queue)), Effect.forkScoped)

        return Stream.fromQueue(queue)
      }),
    )
