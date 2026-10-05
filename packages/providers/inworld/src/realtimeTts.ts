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
import { Effect, Option, Predicate, Redacted, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import type { CustomPronunciation } from "@effect-uai/core/SpeechSynthesizer"
import * as WebSocketSession from "@effect-uai/core/WebSocketSession"
import { audioConfigFor, decodeAudioContent, defaultFormat } from "./codec.js"
import type { InworldDeliveryMode, InworldTtsModel, InworldVoiceId } from "./models.js"
import { authedWsConstructor } from "./wsAuth.js"

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  /**
   * Build the socket yourself, for a proxy or an in-memory transport. The
   * default attaches the Basic auth header through the `ws` package.
   */
  readonly webSocket?: Socket.WebSocketConstructor["Service"]
}

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
  /** Carried from the Common request so the WS path can reject inline
   *  pronunciations (no place to rewrite into a chunked text stream). */
  readonly pronunciations?: ReadonlyArray<CustomPronunciation>
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

/** One raw text frame to at most one audio chunk; error frames are logged, not raised. */
const frameToChunk = (raw: string): Effect.Effect<AudioChunk | undefined> =>
  Effect.gen(function* () {
    const json = yield* JSONL.parseSafe(raw)
    if (json === undefined) return undefined
    const decoded = yield* decodeServerFrame(json).pipe(Effect.option)
    if (Option.isNone(decoded)) return undefined
    const frame = decoded.value
    if (frame.error !== undefined) {
      yield* Effect.logWarning("[inworld-tts] server error frame", { error: frame.error })
      return undefined
    }
    const audio = frame.result?.audioChunk?.audioContent
    if (audio === undefined || audio === "") return undefined
    const bytes = yield* decodeAudioContent(audio).pipe(Effect.option)
    return Option.match(bytes, {
      onNone: () => undefined,
      onSome: (b): AudioChunk => ({ bytes: b }),
    })
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
        // Inline pronunciations are load-bearing (bucket 1) but there is no
        // single text to rewrite `/ipa/` into on a chunked stream. Reject
        // rather than silently drop; use sync `synthesize` for overrides.
        if (request.pronunciations !== undefined && request.pronunciations.length > 0) {
          return Stream.fail(
            new AiError.Unsupported({
              provider: "inworld",
              capability: "pronunciations",
              reason:
                "Inworld applies inline /ipa/ pronunciations on sync `synthesize` only; the incremental WS path streams text in chunks with no place to rewrite. Use `synthesize` for pronunciation overrides.",
            }),
          )
        }
        const create = yield* createFrame(request)
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg)).pipe(
          Effect.provideService(
            Socket.WebSocketConstructor,
            cfg.webSocket ?? authedWsConstructor(cfg.apiKey),
          ),
        )
        const { write } = yield* socket.writer
        const asAiError = WebSocketSession.toAiError("inworld")

        const chunks = Stream.fromPull(Socket.readerString(socket)).pipe(
          Stream.scoped,
          Stream.catchIf(WebSocketSession.isCleanClose, () => Stream.empty),
          Stream.mapError(asAiError),
          Stream.mapEffect(frameToChunk),
          Stream.filter(Predicate.isNotUndefined),
        )

        const outgoing = Stream.concat(
          Stream.make(create),
          Stream.concat(
            textIn.pipe(
              Stream.filter((text) => text.length > 0),
              Stream.map(sendTextFrame),
            ),
            Stream.make(closeContextFrame),
          ),
        ).pipe(Stream.mapEffect((frame) => Effect.mapError(write(frame), asAiError)))

        // The server drains remaining audio after `close_context`, then closes.
        return Stream.merge(chunks, Stream.drain(outgoing), { haltStrategy: "left" })
      }),
    )
