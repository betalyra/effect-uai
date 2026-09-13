/**
 * OpenAI Realtime STT: a `type: "transcription"` session on
 * `wss://api.openai.com/v1/realtime?intent=transcription` (GA wire, no
 * `OpenAI-Beta` header).
 *
 * The WS upgrade needs an `Authorization: Bearer` header, which the browser
 * `WebSocket` API doesn't allow. This module uses the `ws` peer dep to set
 * it. The `ws` dep is only pulled in transitively via
 * `OpenAIRealtimeTranscriber`; `OpenAITranscriber` (sync) stays free of it.
 */
import { Cause, Effect, Encoding, Match, Option, Queue, Redacted, Schema, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import type { TranscriptEvent } from "@effect-uai/core/Transcript"
import type { CommonStreamTranscribeRequest } from "@effect-uai/core/Transcriber"
import { WebSocket as WSWebSocket } from "ws"
import { type OpenAiRegion, resolveHost } from "./region.js"

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: OpenAiRegion
}

// ---------------------------------------------------------------------------
// AudioFormat -> `session.audio.input.format`
// ---------------------------------------------------------------------------

type WireFormat =
  | { readonly type: "audio/pcm"; readonly rate: 24000 }
  | { readonly type: "audio/pcmu" }
  | { readonly type: "audio/pcma" }

const unsupportedFormat = (format: AudioFormat) =>
  new AiError.Unsupported({
    provider: "openai",
    capability: "inputFormat",
    reason: `OpenAI Realtime accepts pcm_s16le @ 24000, pcm_mulaw @ 8000, or pcm_alaw @ 8000 only. Got ${JSON.stringify(format)}.`,
  })

const inputFormatToWire: (format: AudioFormat) => Effect.Effect<WireFormat, AiError.AiError> =
  Match.type<AudioFormat>().pipe(
    Match.when({ container: "raw", encoding: "pcm_s16le", sampleRate: 24000 }, () =>
      Effect.succeed<WireFormat>({ type: "audio/pcm", rate: 24000 }),
    ),
    Match.when({ container: "raw", encoding: "pcm_mulaw", sampleRate: 8000 }, () =>
      Effect.succeed<WireFormat>({ type: "audio/pcmu" }),
    ),
    Match.when({ container: "raw", encoding: "pcm_alaw", sampleRate: 8000 }, () =>
      Effect.succeed<WireFormat>({ type: "audio/pcma" }),
    ),
    Match.orElse((f) => Effect.fail(unsupportedFormat(f))),
  )

// ---------------------------------------------------------------------------
// URL + frame builders
// ---------------------------------------------------------------------------

const wsBaseUrl = (cfg: Config) => resolveHost(cfg).replace(/^http/, "ws")

// Without `intent` (or `model`) the GA server closes with `missing_model` (verified 2026-09-12).
const buildWsUrl = (cfg: Config) => `${wsBaseUrl(cfg)}/realtime?intent=transcription`

const sessionUpdateFrame = (wireFormat: WireFormat, request: CommonStreamTranscribeRequest) =>
  JSON.stringify({
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: wireFormat,
          transcription: {
            model: request.model,
            ...(request.language !== undefined && { language: request.language }),
            ...(request.prompt !== undefined && { prompt: request.prompt }),
          },
          // Server VAD is what commits a turn, and a committed turn is what the
          // server transcribes into a `final`. Models without turn detection
          // reject the field, so those need `vadEvents: false`.
          ...(request.vadEvents !== false && { turn_detection: { type: "server_vad" } }),
        },
      },
    },
  })

const encodeAudioFrame = (bytes: Uint8Array) =>
  JSON.stringify({
    type: "input_audio_buffer.append",
    audio: Encoding.encodeBase64(bytes),
  })

// ---------------------------------------------------------------------------
// Wire schemas (server -> client)
// ---------------------------------------------------------------------------

const RealtimeError = Schema.Struct({
  type: Schema.optional(Schema.String),
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.String,
})

const ServerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session.created") }),
  Schema.Struct({ type: Schema.Literal("session.updated") }),
  Schema.Struct({
    type: Schema.Literal("conversation.item.input_audio_transcription.delta"),
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("conversation.item.input_audio_transcription.completed"),
    transcript: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("input_audio_buffer.speech_started"),
    audio_start_ms: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("input_audio_buffer.speech_stopped"),
    audio_end_ms: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("error"), error: RealtimeError }),
])
const decodeServerEvent = Schema.decodeUnknownEffect(ServerEvent)

export const wireToEvent: (msg: typeof ServerEvent.Type) => TranscriptEvent | undefined =
  Match.type<typeof ServerEvent.Type>().pipe(
    // Handshake acks, no user-visible event.
    Match.whenOr({ type: "session.created" }, { type: "session.updated" }, () => undefined),
    Match.when(
      { type: "conversation.item.input_audio_transcription.delta" },
      (m): TranscriptEvent => ({ _tag: "partial", text: m.delta }),
    ),
    Match.when(
      { type: "conversation.item.input_audio_transcription.completed" },
      (m): TranscriptEvent => ({ _tag: "final", text: m.transcript }),
    ),
    Match.when({ type: "input_audio_buffer.speech_started" }, (m): TranscriptEvent => ({
      _tag: "speech-started",
      atSeconds: (m.audio_start_ms ?? 0) / 1000,
    })),
    Match.when({ type: "input_audio_buffer.speech_stopped" }, (m): TranscriptEvent => ({
      _tag: "utterance-ended",
      atSeconds: (m.audio_end_ms ?? 0) / 1000,
    })),
    Match.when({ type: "error" }, (m): TranscriptEvent => ({
      _tag: "error",
      ...(m.error.code != null && { code: m.error.code }),
      message: m.error.message,
    })),
    Match.exhaustive,
  )

/** One raw text frame to at most one event; unknown or malformed frames yield `undefined`. */
export const frameToEvent = (raw: string): Effect.Effect<TranscriptEvent | undefined> =>
  Effect.gen(function* () {
    const json = yield* JSONL.parseSafe(raw)
    if (json === undefined) return undefined
    yield* Effect.logDebug("[openai realtime stt] frame", { frame: json })
    const decoded = yield* decodeServerEvent(json).pipe(Effect.option)
    return Option.match(decoded, { onNone: () => undefined, onSome: wireToEvent })
  })

const handleServerMessage = (queue: Queue.Queue<TranscriptEvent, Cause.Done>) => (raw: string) =>
  Effect.gen(function* () {
    const event = yield* frameToEvent(raw)
    if (event !== undefined) yield* Queue.offer(queue, event)
  })

// ---------------------------------------------------------------------------
// Stream<Uint8Array> -> Stream<TranscriptEvent>
// ---------------------------------------------------------------------------

// Single contained cast: `@types/ws` declares its WebSocket class extending
// Node's EventEmitter while `globalThis.WebSocket` extends EventTarget. The
// browser-style surface Effect's `Socket.fromWebSocket` reads
// (`addEventListener` / `send` / `close`) is identical at runtime.
const authedWsConstructor =
  (cfg: Config): Socket.WebSocketConstructor["Service"] =>
  (url) =>
    new WSWebSocket(url, undefined, {
      headers: { Authorization: `Bearer ${Redacted.value(cfg.apiKey)}` },
    }) as unknown as globalThis.WebSocket

export const streamTranscription =
  (cfg: Config) =>
  <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ): Stream.Stream<TranscriptEvent, AiError.AiError | E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // OpenAI Realtime has no keyterm field, only the prose `prompt`.
        yield* Capabilities.warnDroppedWhen(request.biasingTerms, {
          provider: "openai",
          capability: "biasing",
          field: "biasingTerms",
          reason: "OpenAI Realtime transcription has no keyterm field; use `prompt`.",
        })
        const wireFormat = yield* inputFormatToWire(request.inputFormat)
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg), {
          // Effect's Socket treats every close code as an error by default.
          closeCodeIsError: (code) => code !== 1000 && code !== 1001 && code !== 1005,
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, authedWsConstructor(cfg)))
        const queue = yield* Queue.bounded<TranscriptEvent, Cause.Done>(64)
        const write = yield* socket.writer

        // session.update first, then drain audio. Both fork-scoped so the
        // Stream's downstream scope tears them down on disconnect / cancel.
        yield* Effect.gen(function* () {
          yield* write(sessionUpdateFrame(wireFormat, request))
          yield* Stream.runForEach(audioIn, (bytes) => write(encodeAudioFrame(bytes)))
        }).pipe(Effect.ignore, Effect.forkScoped)

        // `Queue.end` flushes pending events then ends the stream cleanly;
        // `Queue.shutdown` would drop queued items.
        yield* socket
          .runString(handleServerMessage(queue))
          .pipe(Effect.ensuring(Queue.end(queue)), Effect.forkScoped)

        return Stream.fromQueue(queue)
      }),
    )
