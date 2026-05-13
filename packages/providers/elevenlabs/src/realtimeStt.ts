import { Effect, Encoding, Match, Queue, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat } from "@effect-uai/core/Audio"
import type { TranscriptEvent, WordTimestamp } from "@effect-uai/core/Transcript"
import type { CommonStreamTranscribeRequest } from "@effect-uai/core/Transcriber"
import { httpStatusError, parseJson, transportFailure } from "./codec.js"

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }

// ---------------------------------------------------------------------------
// AudioFormat → audio_format slug
// ---------------------------------------------------------------------------

const unsupportedInputFormat = (format: AudioFormat) =>
  new AiError.Unsupported({
    provider: "elevenlabs",
    capability: "inputFormat",
    reason: `ElevenLabs realtime STT accepts pcm_<rate> or ulaw_8000 only. Got ${JSON.stringify(format)}.`,
  })

export const inputFormatToSlug: (format: AudioFormat) => Effect.Effect<string, AiError.AiError> =
  Match.type<AudioFormat>().pipe(
    Match.when({ container: "raw", encoding: "pcm_s16le" }, (f) =>
      Effect.succeed(`pcm_${f.sampleRate}`),
    ),
    Match.when({ container: "raw", encoding: "pcm_mulaw", sampleRate: 8000 }, () =>
      Effect.succeed("ulaw_8000"),
    ),
    Match.orElse((f) => Effect.fail(unsupportedInputFormat(f))),
  )

// ---------------------------------------------------------------------------
// Single-use token — auth rides on a query param so any
// `globalThis.WebSocket` works (browser, Node 22+, Bun, Deno).
// ---------------------------------------------------------------------------

const TokenWire = Schema.Struct({ token: Schema.String })
const decodeToken = Schema.decodeUnknownEffect(TokenWire)

export const fetchSingleUseToken = (cfg: Config) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const url = `${cfg.baseUrl ?? "https://api.elevenlabs.io/v1"}/single-use-token/realtime_scribe`
    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("xi-api-key", Redacted.value(cfg.apiKey)),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* Effect.fail(httpStatusError(response.status, text))
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeToken(json).pipe(
      Effect.mapError(
        (cause) =>
          new AiError.GenerationFailed({
            provider: "elevenlabs",
            raw: { message: "single-use-token response missing `token` field", cause, json },
          }),
      ),
    )
    return wire.token
  })

// ---------------------------------------------------------------------------
// Wire schemas (server → client)
// ---------------------------------------------------------------------------

const RealtimeWord = Schema.Struct({
  text: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
  type: Schema.optional(Schema.String),
  speaker_id: Schema.optional(Schema.NullOr(Schema.String)),
  logprob: Schema.optional(Schema.Number),
})

const ServerMessage = Schema.Union([
  Schema.Struct({
    message_type: Schema.Literal("session_started"),
    session_id: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    message_type: Schema.Literal("partial_transcript"),
    text: Schema.String,
  }),
  Schema.Struct({
    message_type: Schema.Literal("committed_transcript"),
    text: Schema.String,
  }),
  Schema.Struct({
    message_type: Schema.Literal("committed_transcript_with_timestamps"),
    text: Schema.String,
    language_code: Schema.optional(Schema.NullOr(Schema.String)),
    words: Schema.optional(Schema.NullOr(Schema.Array(RealtimeWord))),
  }),
  Schema.Struct({
    message_type: Schema.Literals(["error", "auth_error", "rate_limited", "quota_exceeded"]),
    error: Schema.optional(Schema.Unknown),
  }),
])
const decodeServerMessage = Schema.decodeUnknownEffect(ServerMessage)

const wireToWordTimestamp = (w: typeof RealtimeWord.Type): WordTimestamp => ({
  text: w.text,
  startSeconds: w.start,
  endSeconds: w.end,
  ...(w.speaker_id != null && { speakerId: w.speaker_id }),
  ...(w.logprob !== undefined && { confidence: Math.exp(w.logprob) }),
})

export const wireToEvent: (msg: typeof ServerMessage.Type) => TranscriptEvent | undefined =
  Match.type<typeof ServerMessage.Type>().pipe(
    Match.when({ message_type: "session_started" }, () => undefined),
    Match.when(
      { message_type: "partial_transcript" },
      (m): TranscriptEvent => ({ _tag: "partial", text: m.text }),
    ),
    // The realtime endpoint emits both `committed_transcript` and
    // `committed_transcript_with_timestamps` for the same segment — the
    // latter is always a superset. Suppress the text-only variant so the
    // consumer sees one `final` per utterance instead of two.
    Match.when({ message_type: "committed_transcript" }, () => undefined),
    Match.when({ message_type: "committed_transcript_with_timestamps" }, (m): TranscriptEvent => {
      const words = m.words == null ? undefined : m.words.map(wireToWordTimestamp)
      return {
        _tag: "final",
        text: m.text,
        ...(m.language_code != null && { languageCode: m.language_code }),
        ...(words !== undefined && words.length > 0 && { words }),
      }
    }),
    Match.orElse(
      (m): TranscriptEvent => ({
        _tag: "error",
        code: m.message_type,
        message:
          typeof m.error === "string"
            ? m.error
            : JSON.stringify(m.error ?? `ElevenLabs ${m.message_type}`),
      }),
    ),
  )

// ---------------------------------------------------------------------------
// URL + frame builders
// ---------------------------------------------------------------------------

export type RealtimeOptions = {
  readonly model?: string
  readonly languageCode?: string
  readonly includeTimestamps?: boolean
  readonly commitStrategy?: "manual" | "vad"
}

export const buildWsUrl = (
  cfg: Config,
  token: string,
  audioFormat: string,
  opts: RealtimeOptions,
) => {
  const wsBase = (cfg.baseUrl ?? "https://api.elevenlabs.io/v1").replace(/^http/, "ws")
  const params = new URLSearchParams({
    token,
    audio_format: audioFormat,
    commit_strategy: opts.commitStrategy ?? "vad",
    ...(opts.model !== undefined && { model_id: opts.model }),
    ...(opts.languageCode !== undefined && { language_code: opts.languageCode }),
    ...(opts.includeTimestamps === true && { include_timestamps: "true" }),
  })
  return `${wsBase}/speech-to-text/realtime?${params.toString()}`
}

export const encodeAudioFrame = (bytes: Uint8Array, sampleRate: number) =>
  JSON.stringify({
    message_type: "input_audio_chunk",
    audio_base_64: Encoding.encodeBase64(bytes),
    sample_rate: sampleRate,
  })

// ---------------------------------------------------------------------------
// Parse one server message and emit to the queue if it maps to a
// TranscriptEvent. Invalid JSON / unknown shapes are silently dropped —
// the connection stays open and we keep streaming subsequent messages.
// ---------------------------------------------------------------------------

const handleServerMessage = (queue: Queue.Queue<TranscriptEvent>) => (raw: string) =>
  Effect.gen(function* () {
    const json = yield* parseJson(raw)
    if (json === undefined) return
    const decoded = yield* decodeServerMessage(json).pipe(Effect.option)
    if (decoded._tag === "None") return
    const event = wireToEvent(decoded.value)
    if (event !== undefined) yield* Queue.offer(queue, event)
  })

// ---------------------------------------------------------------------------
// Stream<Uint8Array> → Stream<TranscriptEvent>
//
// Requires `HttpClient` (single-use token fetch) and
// `Socket.WebSocketConstructor` (any `globalThis.WebSocket` works) in
// context — `Socket.layerWebSocketConstructorGlobal` covers every
// modern runtime.
// ---------------------------------------------------------------------------

export const streamTranscription =
  (cfg: Config) =>
  <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ): Stream.Stream<
    TranscriptEvent,
    AiError.AiError | E,
    R | HttpClient.HttpClient | Socket.WebSocketConstructor
  > =>
    Stream.unwrap(
      Effect.gen(function* () {
        const slug = yield* inputFormatToSlug(request.inputFormat)
        const token = yield* fetchSingleUseToken(cfg)
        const url = buildWsUrl(cfg, token, slug, {
          ...(request.model !== undefined && { model: request.model }),
          ...(request.language !== undefined && { languageCode: request.language }),
          includeTimestamps: request.wordTimestamps === true,
        })
        const socket = yield* Socket.makeWebSocket(url)
        const queue = yield* Queue.bounded<TranscriptEvent>(64)
        const sampleRate = request.inputFormat.sampleRate

        const write = yield* socket.writer
        yield* Stream.runForEach(audioIn, (bytes) =>
          write(encodeAudioFrame(bytes, sampleRate)),
        ).pipe(Effect.ignore, Effect.forkScoped)

        yield* socket
          .runString(handleServerMessage(queue))
          .pipe(Effect.ensuring(Queue.shutdown(queue)), Effect.forkScoped)

        return Stream.fromQueue(queue)
      }),
    )
