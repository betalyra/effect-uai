import { Effect, Encoding, Queue, Redacted, Schema, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import {
  defaultFormat,
  formatToOutputSlug,
} from "./codec.js"
import type { ElevenLabsTtsModel, ElevenLabsVoiceId } from "./models.js"

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

export type VoiceSettings = {
  readonly stability?: number
  readonly similarityBoost?: number
  readonly style?: number
  readonly useSpeakerBoost?: boolean
  readonly speed?: number
}

/**
 * Incremental-text-in request for the ElevenLabs `/stream-input`
 * WebSocket. `voiceSettings` only takes effect on the BOS frame — the
 * ElevenLabs protocol rejects mid-stream voice changes. `autoMode`
 * defaults to true so the model decides when to flush, which is what
 * you want for LLM-token streams.
 */
export type StreamSynthesizeRequest = {
  readonly model?: ElevenLabsTtsModel
  readonly voiceId: ElevenLabsVoiceId
  readonly outputFormat?: AudioFormat
  readonly languageCode?: string
  readonly voiceSettings?: VoiceSettings
  readonly autoMode?: boolean
}

// ---------------------------------------------------------------------------
// URL + frame builders
// ---------------------------------------------------------------------------

const wireVoiceSettings = (v: VoiceSettings | undefined) =>
  v === undefined
    ? undefined
    : {
        ...(v.stability !== undefined && { stability: v.stability }),
        ...(v.similarityBoost !== undefined && { similarity_boost: v.similarityBoost }),
        ...(v.style !== undefined && { style: v.style }),
        ...(v.useSpeakerBoost !== undefined && { use_speaker_boost: v.useSpeakerBoost }),
        ...(v.speed !== undefined && { speed: v.speed }),
      }

export const buildWsUrl = (
  cfg: Config,
  request: StreamSynthesizeRequest,
  outputFormat: string,
) => {
  const wsBase = (cfg.baseUrl ?? "https://api.elevenlabs.io/v1").replace(/^http/, "ws")
  const params = new URLSearchParams({
    output_format: outputFormat,
    auto_mode: String(request.autoMode ?? true),
    ...(request.model !== undefined && { model_id: request.model }),
    ...(request.languageCode !== undefined && { language_code: request.languageCode }),
  })
  return `${wsBase}/text-to-speech/${request.voiceId}/stream-input?${params.toString()}`
}

/**
 * The BOS frame primes the connection: it MUST be sent first with
 * `text: " "` (literal space), and is the only frame that may carry
 * `voice_settings` and (here) the API key.
 */
const bosFrame = (cfg: Config, request: StreamSynthesizeRequest) => {
  const vs = wireVoiceSettings(request.voiceSettings)
  return JSON.stringify({
    text: " ",
    "xi-api-key": Redacted.value(cfg.apiKey),
    ...(vs !== undefined && { voice_settings: vs }),
  })
}

const textFrame = (text: string) => JSON.stringify({ text: text.endsWith(" ") ? text : `${text} ` })
const eosFrame = JSON.stringify({ text: "" })

// ---------------------------------------------------------------------------
// Wire schema (server → client)
// ---------------------------------------------------------------------------

const ServerFrame = Schema.Struct({
  audio: Schema.optional(Schema.NullOr(Schema.String)),
  isFinal: Schema.optional(Schema.NullOr(Schema.Boolean)),
  error: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
})
const decodeServerFrame = Schema.decodeUnknownEffect(ServerFrame)

const decodeAudio = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Effect.suspend(() => {
    const result = Encoding.decodeBase64(b64)
    return result._tag === "Success"
      ? Effect.succeed(result.success)
      : Effect.fail(
          new AiError.GenerationFailed({
            provider: "elevenlabs",
            raw: { message: "failed to decode audio frame", cause: result.failure },
          }),
        )
  })

const handleServerFrame = (queue: Queue.Queue<AudioChunk>) => (raw: string) =>
  Effect.suspend(() => {
    const parsed = Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))
    return Effect.flatMap(parsed, (json) =>
      json === undefined
        ? Effect.void
        : decodeServerFrame(json).pipe(
            Effect.flatMap((frame) => {
              if (frame.error !== undefined) {
                return Effect.logWarning("[elevenlabs-tts] server error frame", {
                  error: frame.error,
                  message: frame.message,
                })
              }
              if (frame.audio == null || frame.audio === "") return Effect.void
              return decodeAudio(frame.audio).pipe(
                Effect.flatMap((bytes) => Queue.offer(queue, { bytes })),
                Effect.orElseSucceed(() => undefined),
              )
            }),
            Effect.orElseSucceed(() => undefined),
            Effect.asVoid,
          ),
    )
  })

// ---------------------------------------------------------------------------
// Stream<string> → Stream<AudioChunk>
//
// Requires `Socket.WebSocketConstructor` in context.
// ---------------------------------------------------------------------------

export const streamSynthesis =
  (cfg: Config) =>
  <E, R>(
    textIn: Stream.Stream<string, E, R>,
    request: StreamSynthesizeRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError | E, R | Socket.WebSocketConstructor> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const format = request.outputFormat ?? defaultFormat
        const slug = yield* formatToOutputSlug(format)
        const url = buildWsUrl(cfg, request, slug)
        const socket = yield* Socket.makeWebSocket(url)
        const queue = yield* Queue.bounded<AudioChunk>(64)

        const write = yield* socket.writer

        // Writer fiber: BOS → drain text stream → EOS. Socket-side
        // failures end this fiber; the reader still surfaces the
        // resulting close event downstream as a clean stream end.
        yield* Effect.gen(function* () {
          yield* write(bosFrame(cfg, request))
          yield* Stream.runForEach(textIn, (text) =>
            text.length === 0 ? Effect.void : write(textFrame(text)),
          )
          yield* write(eosFrame)
        }).pipe(Effect.ignore, Effect.forkScoped)

        yield* socket
          .runString(handleServerFrame(queue))
          .pipe(Effect.ensuring(Queue.shutdown(queue)), Effect.forkScoped)

        return Stream.fromQueue(queue)
      }),
    )
