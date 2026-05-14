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
import { Effect, Encoding, Match, Queue, Redacted, Schema, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import type { TranscriptEvent, WordTimestamp } from "@effect-uai/core/Transcript"
import type { CommonStreamTranscribeRequest } from "@effect-uai/core/Transcriber"
import { authedWsConstructor } from "./wsAuth.js"

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

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

const promptToTerms = (
  prompt: string | { readonly terms: ReadonlyArray<string> } | undefined,
): ReadonlyArray<string> | undefined =>
  prompt === undefined ? undefined : typeof prompt === "string" ? [prompt] : prompt.terms

const configFrame = (encoding: WireEncoding, request: CommonStreamTranscribeRequest) => {
  const prompts = promptToTerms(request.prompt)
  return JSON.stringify({
    transcribeConfig: {
      modelId: request.model,
      audioEncoding: encoding,
      sampleRateHertz: request.inputFormat.sampleRate,
      numberOfChannels: request.inputFormat.channels ?? 1,
      // Inworld's sample includes `language` even though docs mark it optional.
      // Default to en-US to match the sample's behavior; caller can override.
      language: request.language ?? "en-US",
      ...(prompts !== undefined && { prompts }),
      ...(request.wordTimestamps === true && { includeWordTimestamps: true }),
    },
  })
}

const audioChunkFrame = (bytes: Uint8Array) =>
  JSON.stringify({ audioChunk: { content: Encoding.encodeBase64(bytes) } })

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

const handleServerMessage = (queue: Queue.Queue<TranscriptEvent>) => (raw: string) =>
  Effect.gen(function* () {
    const json = yield* JSONL.parseSafe(raw)
    if (json === undefined) return
    const decoded = yield* decodeServerFrame(json).pipe(Effect.option)
    if (decoded._tag === "None") return
    const event = wireToEvent(decoded.value)
    if (event !== undefined) yield* Queue.offer(queue, event)
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
        const encoding = yield* inputFormatToWire(request.inputFormat)
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg)).pipe(
          Effect.provideService(Socket.WebSocketConstructor, authedWsConstructor(cfg.apiKey)),
        )
        const queue = yield* Queue.bounded<TranscriptEvent>(64)
        const write = yield* socket.writer

        // Writer: config → drain audio → endTurn → closeStream. Inworld
        // emits `result.transcription` partials in real-time via VAD;
        // `endTurn` is sent on input-stream end to flush any tail audio
        // into a final transcript, then `closeStream` for graceful close.
        yield* Effect.gen(function* () {
          yield* write(configFrame(encoding, request))
          yield* Stream.runForEach(audioIn, (bytes) => write(audioChunkFrame(bytes)))
          yield* write(endTurnFrame)
          yield* write(closeStreamFrame)
        }).pipe(Effect.ignore, Effect.forkScoped)

        yield* socket
          .runString(handleServerMessage(queue))
          .pipe(Effect.ensuring(Queue.shutdown(queue)), Effect.forkScoped)

        return Stream.fromQueue(queue)
      }),
    )
