/**
 * OpenAI Realtime STT — `wss://api.openai.com/v1/realtime?intent=transcription`.
 *
 * The WS upgrade needs `Authorization: Bearer …` + `OpenAI-Beta: realtime=v1`
 * headers, which the browser `WebSocket` API doesn't allow. This module uses
 * the `ws` peer dep to set them. The `ws` dep is only pulled in transitively
 * via `OpenAIRealtimeTranscriber`; `OpenAITranscriber` (sync) stays free of
 * it.
 */
import { Effect, Encoding, Match, Queue, Redacted, Schema, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import type { TranscriptEvent } from "@effect-uai/core/Transcript"
import type { CommonStreamTranscribeRequest } from "@effect-uai/core/Transcriber"
import { WebSocket as WSWebSocket } from "ws"

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

// ---------------------------------------------------------------------------
// AudioFormat → OpenAI `input_audio_format`
// ---------------------------------------------------------------------------

type WireFormat = "pcm16" | "g711_ulaw" | "g711_alaw"

const unsupportedFormat = (format: AudioFormat) =>
  new AiError.Unsupported({
    provider: "openai",
    capability: "inputFormat",
    reason: `OpenAI Realtime accepts pcm_s16le @ 24000, pcm_mulaw @ 8000, or pcm_alaw @ 8000 only. Got ${JSON.stringify(format)}.`,
  })

const inputFormatToWire: (format: AudioFormat) => Effect.Effect<WireFormat, AiError.AiError> =
  Match.type<AudioFormat>().pipe(
    Match.when({ container: "raw", encoding: "pcm_s16le", sampleRate: 24000 }, () =>
      Effect.succeed<WireFormat>("pcm16"),
    ),
    Match.when({ container: "raw", encoding: "pcm_mulaw", sampleRate: 8000 }, () =>
      Effect.succeed<WireFormat>("g711_ulaw"),
    ),
    Match.when({ container: "raw", encoding: "pcm_alaw", sampleRate: 8000 }, () =>
      Effect.succeed<WireFormat>("g711_alaw"),
    ),
    Match.orElse((f) => Effect.fail(unsupportedFormat(f))),
  )

// ---------------------------------------------------------------------------
// URL + frame builders
// ---------------------------------------------------------------------------

const wsBaseUrl = (cfg: Config) =>
  (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/^http/, "ws")

const buildWsUrl = (cfg: Config) => `${wsBaseUrl(cfg)}/realtime?intent=transcription`

const promptToString = (
  prompt: string | { readonly terms: ReadonlyArray<string> } | undefined,
): string | undefined =>
  prompt === undefined ? undefined : typeof prompt === "string" ? prompt : prompt.terms.join(", ")

const sessionUpdateFrame = (wireFormat: WireFormat, request: CommonStreamTranscribeRequest) => {
  const prompt = promptToString(request.prompt)
  return JSON.stringify({
    type: "transcription_session.update",
    session: {
      input_audio_format: wireFormat,
      input_audio_transcription: {
        model: request.model,
        ...(request.language !== undefined && { language: request.language }),
        ...(prompt !== undefined && { prompt }),
      },
      // VAD on by default — emits `speech_started` / `speech_stopped` events.
      // Caller opts out via `vadEvents: false`.
      ...(request.vadEvents !== false && { turn_detection: { type: "server_vad" } }),
    },
  })
}

const encodeAudioFrame = (bytes: Uint8Array) =>
  JSON.stringify({
    type: "input_audio_buffer.append",
    audio: Encoding.encodeBase64(bytes),
  })

// ---------------------------------------------------------------------------
// Wire schemas (server → client)
// ---------------------------------------------------------------------------

const RealtimeError = Schema.Struct({
  type: Schema.optional(Schema.String),
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.String,
})

const ServerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("transcription_session.created") }),
  Schema.Struct({ type: Schema.Literal("transcription_session.updated") }),
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
    // session.created / .updated are connection handshake acks — no
    // user-visible event.
    Match.whenOr(
      { type: "transcription_session.created" },
      { type: "transcription_session.updated" },
      () => undefined,
    ),
    Match.when(
      { type: "conversation.item.input_audio_transcription.delta" },
      (m): TranscriptEvent => ({ _tag: "partial", text: m.delta }),
    ),
    Match.when(
      { type: "conversation.item.input_audio_transcription.completed" },
      (m): TranscriptEvent => ({ _tag: "final", text: m.transcript }),
    ),
    Match.when(
      { type: "input_audio_buffer.speech_started" },
      (m): TranscriptEvent => ({
        _tag: "speech-started",
        atSeconds: (m.audio_start_ms ?? 0) / 1000,
      }),
    ),
    Match.when(
      { type: "input_audio_buffer.speech_stopped" },
      (m): TranscriptEvent => ({
        _tag: "utterance-ended",
        atSeconds: (m.audio_end_ms ?? 0) / 1000,
      }),
    ),
    Match.when(
      { type: "error" },
      (m): TranscriptEvent => ({
        _tag: "error",
        ...(m.error.code != null && { code: m.error.code }),
        message: m.error.message,
      }),
    ),
    Match.exhaustive,
  )

const handleServerMessage = (queue: Queue.Queue<TranscriptEvent>) => (raw: string) =>
  Effect.gen(function* () {
    const json = yield* JSONL.parseSafe(raw)
    if (json === undefined) return
    const decoded = yield* decodeServerEvent(json).pipe(Effect.option)
    if (decoded._tag === "None") return
    const event = wireToEvent(decoded.value)
    if (event !== undefined) yield* Queue.offer(queue, event)
  })

// ---------------------------------------------------------------------------
// Stream<Uint8Array> → Stream<TranscriptEvent>
// ---------------------------------------------------------------------------

// Single contained cast: `@types/ws` declares its WebSocket class extending
// Node's EventEmitter while `globalThis.WebSocket` extends EventTarget. The
// browser-style surface Effect's `Socket.fromWebSocket` reads
// (`addEventListener` / `send` / `close`) is identical at runtime.
const authedWsConstructor =
  (cfg: Config): Socket.WebSocketConstructor["Service"] =>
  (url) =>
    new WSWebSocket(url, undefined, {
      headers: {
        Authorization: `Bearer ${Redacted.value(cfg.apiKey)}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }) as unknown as globalThis.WebSocket

export const streamTranscription =
  (cfg: Config) =>
  <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ): Stream.Stream<TranscriptEvent, AiError.AiError | E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const wireFormat = yield* inputFormatToWire(request.inputFormat)
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg), {
          // Effect's Socket treats all close codes as errors by default —
          // whitelist standard clean-close codes (1000 / 1001 / 1005).
          closeCodeIsError: (code) => code !== 1000 && code !== 1001 && code !== 1005,
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, authedWsConstructor(cfg)))
        const queue = yield* Queue.bounded<TranscriptEvent>(64)
        const write = yield* socket.writer

        // session.update first, then drain audio. Both fork-scoped so the
        // Stream's downstream scope tears them down on disconnect / cancel.
        yield* Effect.gen(function* () {
          yield* write(sessionUpdateFrame(wireFormat, request))
          yield* Stream.runForEach(audioIn, (bytes) => write(encodeAudioFrame(bytes)))
        }).pipe(Effect.ignore, Effect.forkScoped)

        yield* socket
          .runString(handleServerMessage(queue))
          .pipe(Effect.ensuring(Queue.shutdown(queue)), Effect.forkScoped)

        return Stream.fromQueue(queue)
      }),
    )
