import { Effect, Option, Predicate, Redacted, Result, Schema, Stream } from "effect"
import { Base64 } from "effect/encoding"
import * as Socket from "effect/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioChunk, AudioFormat } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import type { CustomPronunciation } from "@effect-uai/core/SpeechSynthesizer"
import * as WebSocketSession from "@effect-uai/core/WebSocketSession"
import {
  defaultFormat,
  formatToOutputSlug,
  type PronunciationDictionaryLocator,
  rejectInlinePronunciations,
  type VoiceSettings,
  wirePronunciationLocators,
  wireVoiceSettings,
} from "./codec.js"
import type { ElevenLabsTtsModel, ElevenLabsVoiceId } from "./models.js"
import { type ElevenLabsRegion, resolveHost } from "./region.js"

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: ElevenLabsRegion
}

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
  /** Pre-provisioned pronunciation dictionaries, sent on the BOS frame. */
  readonly pronunciationDictionaryLocators?: ReadonlyArray<PronunciationDictionaryLocator>
  /** Carried from the Common request so the WS path can reject inline
   *  pronunciations (ElevenLabs has no stateless inline IPA path). */
  readonly pronunciations?: ReadonlyArray<CustomPronunciation>
}

// ---------------------------------------------------------------------------
// URL + frame builders
// ---------------------------------------------------------------------------

export const buildWsUrl = (cfg: Config, request: StreamSynthesizeRequest, outputFormat: string) => {
  const wsBase = resolveHost(cfg).replace(/^http/, "ws")
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
    ...wirePronunciationLocators(request.pronunciationDictionaryLocators),
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
  Result.match(Base64.decode(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(
        new AiError.GenerationFailed({
          provider: "elevenlabs",
          raw: { message: "failed to decode audio frame", cause },
        }),
      ),
  })

/** One raw text frame to at most one chunk; error frames are logged and dropped. */
const frameToChunk = (raw: string): Effect.Effect<AudioChunk | undefined> =>
  Effect.gen(function* () {
    const json = yield* JSONL.parseSafe(raw)
    if (json === undefined) return undefined
    const decoded = yield* decodeServerFrame(json).pipe(Effect.option)
    if (decoded._tag === "None") return undefined
    const frame = decoded.value
    if (frame.error !== undefined) {
      yield* Effect.logWarning("[elevenlabs-tts] server error frame", {
        error: frame.error,
        message: frame.message,
      })
      return undefined
    }
    if (frame.audio == null || frame.audio === "") return undefined
    const bytes = yield* decodeAudio(frame.audio).pipe(Effect.option)
    return Option.match(bytes, { onNone: () => undefined, onSome: (b) => ({ bytes: b }) })
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
        yield* rejectInlinePronunciations(request.pronunciations)
        const slug = yield* formatToOutputSlug(request.outputFormat ?? defaultFormat)
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg, request, slug))
        const { write } = yield* socket.writer
        const asAiError = WebSocketSession.toAiError("elevenlabs")

        // ElevenLabs closes `/stream-input` with 1000 after the final audio chunk.
        const chunks = Stream.fromPull(Socket.readerString(socket)).pipe(
          Stream.scoped,
          Stream.catchIf(WebSocketSession.isCleanClose, () => Stream.empty),
          Stream.mapError(asAiError),
          Stream.mapEffect(frameToChunk),
          Stream.filter(Predicate.isNotUndefined),
        )

        // BOS, then the text, then EOS. Writes wait for the reader to connect.
        const outgoing = Stream.concat(
          Stream.make(bosFrame(cfg, request)),
          Stream.concat(
            textIn.pipe(
              Stream.filter((text) => text.length > 0),
              Stream.map(textFrame),
            ),
            Stream.make(eosFrame),
          ),
        ).pipe(Stream.mapEffect((frame) => Effect.mapError(write(frame), asAiError)))

        return Stream.merge(chunks, Stream.drain(outgoing), { haltStrategy: "left" })
      }),
    )
