import { Effect, Encoding, Queue, Redacted, Result, Schema, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import {
  defaultFormat,
  formatToOutputSlug,
  type VoiceSettings,
  wireVoiceSettings,
} from "./codec.js"
import type { ElevenLabsTtsModel, ElevenLabsVoiceId } from "./models.js"

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

export type { VoiceSettings } from "./codec.js"

/**
 * Incremental-text-in request for `/stream-input`. `voiceSettings`
 * applies only on the BOS frame — mid-stream voice changes are
 * rejected. `autoMode: true` (default) lets the model pick flush
 * boundaries, which is what you want for LLM-token streams.
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

export const buildWsUrl = (cfg: Config, request: StreamSynthesizeRequest, outputFormat: string) => {
  const wsBase = (cfg.baseUrl ?? "https://api.elevenlabs.io/v1").replace(/^http/, "ws")
  const params = new URLSearchParams({
    output_format: outputFormat,
    auto_mode: String(request.autoMode ?? true),
    ...(request.model !== undefined && { model_id: request.model }),
    ...(request.languageCode !== undefined && { language_code: request.languageCode }),
  })
  return `${wsBase}/text-to-speech/${request.voiceId}/stream-input?${params.toString()}`
}

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
// Wire schema (server → client) + helpers
// ---------------------------------------------------------------------------

const ServerFrame = Schema.Struct({
  audio: Schema.optional(Schema.NullOr(Schema.String)),
  isFinal: Schema.optional(Schema.NullOr(Schema.Boolean)),
  error: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
})
const decodeServerFrame = Schema.decodeUnknownEffect(ServerFrame)

const decodeAudio = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(
        new AiError.GenerationFailed({
          provider: "elevenlabs",
          raw: { message: "failed to decode audio frame", cause },
        }),
      ),
  })

const handleServerFrame = (queue: Queue.Queue<AudioChunk>) => (raw: string) =>
  Effect.gen(function* () {
    const json = yield* JSONL.parseSafe(raw)
    if (json === undefined) return
    const decoded = yield* decodeServerFrame(json).pipe(Effect.option)
    if (decoded._tag === "None") return
    const frame = decoded.value
    if (frame.error !== undefined) {
      yield* Effect.logWarning("[elevenlabs-tts] server error frame", {
        error: frame.error,
        message: frame.message,
      })
      return
    }
    if (frame.audio == null || frame.audio === "") return
    const bytes = yield* decodeAudio(frame.audio).pipe(Effect.option)
    if (bytes._tag === "Some") yield* Queue.offer(queue, { bytes: bytes.value })
  })

// ---------------------------------------------------------------------------
// Stream<string> → Stream<AudioChunk>. Requires `Socket.WebSocketConstructor`.
// ---------------------------------------------------------------------------

export const streamSynthesis =
  (cfg: Config) =>
  <E, R>(
    textIn: Stream.Stream<string, E, R>,
    request: StreamSynthesizeRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError | E, R | Socket.WebSocketConstructor> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const slug = yield* formatToOutputSlug(request.outputFormat ?? defaultFormat)
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg, request, slug))
        const queue = yield* Queue.bounded<AudioChunk>(64)
        const write = yield* socket.writer

        // Writer fiber: BOS → drain text stream → EOS. Socket-side
        // failures end this fiber; the reader still surfaces a clean
        // stream end via Queue.shutdown when the upstream WS closes.
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
