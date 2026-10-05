/**
 * Inworld Realtime STT — `wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional`.
 *
 * Auth: `Authorization: Basic <API_KEY>` on the WS upgrade header (matches
 * Inworld's own JS sample). Setting headers needs the `ws` peer dep
 * (Node/Bun); see `./wsAuth.ts`.
 *
 * Wire shape (per [inworld-ai/inworld-api-examples](https://github.com/inworld-ai/inworld-api-examples)):
 *   client → server:
 *     `{ "transcribeConfig": { modelId, audioEncoding, sampleRateHertz, language, ... } }`  (first frame)
 *     `{ "audioChunk": { "content": "<base64 audio>" } }`                                  (×N)
 *     `{ "closeStream": {} }`                                                              (end-of-input)
 *   server → client:
 *     `{ "result": { "transcription": { "transcript": "...", "isFinal": true|false } } }`
 *     `{ "result": { "speechStarted": { "startTimeMs": ... } } }`
 *     `{ "result": { "speechStopped": { "silenceDurationMs": ... } } }`
 *
 * Inworld's STT WS sends audio as base64 inside JSON (NOT binary frames),
 * matching the rest of the Inworld API style.
 */
import { Effect, Match, Option, Predicate, Redacted, Schema, Stream } from "effect"
import { Base64 } from "effect/encoding"
import * as Socket from "effect/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as Capabilities from "@effect-uai/core/Capabilities"
import * as JSONL from "@effect-uai/core/JSONL"
import type { TranscriptEvent, WordTimestamp } from "@effect-uai/core/Transcript"
import type { CommonStreamTranscribeRequest } from "@effect-uai/core/Transcriber"
import * as WebSocketSession from "@effect-uai/core/WebSocketSession"
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

// ---------------------------------------------------------------------------
// AudioFormat → `audioEncoding` slug for Inworld STT
// ---------------------------------------------------------------------------

type WireEncoding = "LINEAR16" | "MP3" | "OGG_OPUS" | "FLAC"

const unsupportedFormat = (format: AudioFormat) =>
  new AiError.Unsupported({
    provider: "inworld",
    capability: "inputFormat",
    reason: `Inworld realtime STT accepts pcm_s16le (LINEAR16), mp3, ogg/opus, or flac. Got ${JSON.stringify(format)}.`,
  })

const inputFormatToWire: (format: AudioFormat) => Effect.Effect<WireEncoding, AiError.AiError> =
  Match.type<AudioFormat>().pipe(
    Match.when({ container: "raw", encoding: "pcm_s16le" }, () =>
      Effect.succeed<WireEncoding>("LINEAR16"),
    ),
    Match.when({ container: "wav", encoding: "pcm_s16le" }, () =>
      Effect.succeed<WireEncoding>("LINEAR16"),
    ),
    Match.when({ container: "mp3" }, () => Effect.succeed<WireEncoding>("MP3")),
    Match.when({ container: "ogg", encoding: "opus" }, () =>
      Effect.succeed<WireEncoding>("OGG_OPUS"),
    ),
    Match.when({ container: "flac" }, () => Effect.succeed<WireEncoding>("FLAC")),
    Match.orElse((f) => Effect.fail(unsupportedFormat(f))),
  )

// ---------------------------------------------------------------------------
// URL + frame builders
// ---------------------------------------------------------------------------

const buildWsUrl = (cfg: Config) => {
  const wsBase = (cfg.baseUrl ?? "https://api.inworld.ai").replace(/^http/, "ws")
  return `${wsBase}/stt/v1/transcribe:streamBidirectional`
}

const configFrame = (encoding: WireEncoding, request: CommonStreamTranscribeRequest) =>
  JSON.stringify({
    transcribeConfig: {
      modelId: request.model,
      audioEncoding: encoding,
      sampleRateHertz: request.inputFormat.sampleRate,
      numberOfChannels: request.inputFormat.channels ?? 1,
      // Inworld's sample includes `language` even though docs mark it optional.
      // Default to en-US to match the sample's behavior; caller can override.
      language: request.language ?? "en-US",
      // `prompts` is a vocab-biasing term list — maps from `biasingTerms`.
      ...(request.biasingTerms !== undefined && { prompts: request.biasingTerms }),
      ...(request.wordTimestamps === true && { includeWordTimestamps: true }),
    },
  })

const audioChunkFrame = (bytes: Uint8Array) =>
  JSON.stringify({ audioChunk: { content: Base64.encode(bytes) } })

const endTurnFrame = JSON.stringify({ endTurn: {} })
const closeStreamFrame = JSON.stringify({ closeStream: {} })

// ---------------------------------------------------------------------------
// Wire schemas (server → client)
// ---------------------------------------------------------------------------

const WireWord = Schema.Struct({
  word: Schema.String,
  startTimeMs: Schema.optional(Schema.Number),
  endTimeMs: Schema.optional(Schema.Number),
  confidence: Schema.optional(Schema.Number),
})

const ResultBody = Schema.Struct({
  transcription: Schema.optional(
    Schema.Struct({
      transcript: Schema.String,
      isFinal: Schema.optional(Schema.Boolean),
      wordTimestamps: Schema.optional(Schema.NullOr(Schema.Array(WireWord))),
    }),
  ),
  speechStarted: Schema.optional(
    Schema.Struct({
      startTimeMs: Schema.optional(Schema.Number),
      confidence: Schema.optional(Schema.Number),
    }),
  ),
  speechStopped: Schema.optional(
    Schema.Struct({
      silenceDurationMs: Schema.optional(Schema.Number),
    }),
  ),
  status: Schema.optional(Schema.Unknown),
})

const ServerFrame = Schema.Struct({
  result: Schema.optional(ResultBody),
  error: Schema.optional(Schema.Unknown),
})
const decodeServerFrame = Schema.decodeUnknownEffect(ServerFrame)

const wireWordToCommon = (w: typeof WireWord.Type): WordTimestamp | undefined =>
  w.startTimeMs === undefined || w.endTimeMs === undefined
    ? undefined
    : {
        text: w.word,
        startSeconds: w.startTimeMs / 1000,
        endSeconds: w.endTimeMs / 1000,
        ...(w.confidence !== undefined && { confidence: w.confidence }),
      }

export const wireToEvent = (frame: typeof ServerFrame.Type): TranscriptEvent | undefined => {
  if (frame.error !== undefined) {
    return {
      _tag: "error",
      message: typeof frame.error === "string" ? frame.error : JSON.stringify(frame.error),
    }
  }
  const result = frame.result
  if (result === undefined) return undefined
  if (result.transcription !== undefined) {
    const t = result.transcription
    const words = t.wordTimestamps
      ?.map(wireWordToCommon)
      .filter((w): w is WordTimestamp => w !== undefined)
    return t.isFinal === true
      ? {
          _tag: "final",
          text: t.transcript,
          ...(words !== undefined && words.length > 0 && { words }),
        }
      : {
          _tag: "partial",
          text: t.transcript,
          ...(words !== undefined && words.length > 0 && { words }),
        }
  }
  if (result.speechStarted !== undefined) {
    return {
      _tag: "speech-started",
      atSeconds: (result.speechStarted.startTimeMs ?? 0) / 1000,
    }
  }
  if (result.speechStopped !== undefined) {
    return { _tag: "utterance-ended", atSeconds: 0 }
  }
  return undefined
}

/** One raw text frame to at most one event; unknown or malformed frames yield `undefined`. */
const frameToEvent = (raw: string): Effect.Effect<TranscriptEvent | undefined> =>
  Effect.gen(function* () {
    const json = yield* JSONL.parseSafe(raw)
    if (json === undefined) return undefined
    const decoded = yield* decodeServerFrame(json).pipe(Effect.option)
    return Option.match(decoded, { onNone: () => undefined, onSome: wireToEvent })
  })

// ---------------------------------------------------------------------------
// Stream<Uint8Array> → Stream<TranscriptEvent>
// ---------------------------------------------------------------------------

export const streamTranscription =
  (cfg: Config) =>
  <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ): Stream.Stream<TranscriptEvent, AiError.AiError | E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Capabilities.warnDroppedWhen(request.prompt, {
          provider: "inworld",
          capability: "prompt",
          field: "prompt",
          reason: "Inworld STT has no free-form prompt field; bias via `biasingTerms`.",
        })
        const encoding = yield* inputFormatToWire(request.inputFormat)
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg)).pipe(
          Effect.provideService(
            Socket.WebSocketConstructor,
            cfg.webSocket ?? authedWsConstructor(cfg.apiKey),
          ),
        )
        const { write } = yield* socket.writer
        const asAiError = WebSocketSession.toAiError("inworld")

        const events = Stream.fromPull(Socket.readerString(socket)).pipe(
          Stream.scoped,
          Stream.catchIf(WebSocketSession.isCleanClose, () => Stream.empty),
          Stream.mapError(asAiError),
          Stream.mapEffect(frameToEvent),
          Stream.filter(Predicate.isNotUndefined),
        )

        // `endTurn` flushes tail audio into a final transcript before `closeStream`.
        const outgoing = Stream.concat(
          Stream.make(configFrame(encoding, request)),
          Stream.concat(
            Stream.map(audioIn, audioChunkFrame),
            Stream.make(endTurnFrame, closeStreamFrame),
          ),
        ).pipe(Stream.mapEffect((frame) => Effect.mapError(write(frame), asAiError)))

        // The server's close ends the transcript; the audio running out does not.
        return Stream.merge(events, Stream.drain(outgoing), { haltStrategy: "left" })
      }),
    )
