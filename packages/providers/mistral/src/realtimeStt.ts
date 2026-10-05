/**
 * Voxtral Realtime STT over WebSocket.
 *
 * Protocol mirrors the `mistralai[realtime]` Python client:
 *   - URL: `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=…`
 *     (the model is a query param, not a session field).
 *   - Auth: `Authorization: Bearer …` header on the upgrade. The browser
 *     `WebSocket` API can't set headers, so this module uses the `ws` peer
 *     dep; `ws` is only pulled in transitively via
 *     `MistralRealtimeTranscriber` (the sync `MistralTranscriber` stays free
 *     of it).
 *   - Client → server (JSON): `session.update` (audio_format +
 *     target_streaming_delay_ms), then `input_audio.append` with base64 PCM,
 *     and `input_audio.end` when the mic stream stops.
 *   - Server → client (JSON): `session.created` / `session.updated`,
 *     `transcription.text.delta` (`{ text }`), `transcription.done`
 *     (`{ text }`), `transcription.segment`, `transcription.language`,
 *     and `error` (`{ error: { message, code } }`).
 *
 * Voxtral Realtime is a *continuous* transcriber: it streams text deltas and
 * only emits one `transcription.done` at end-of-audio (no server-side
 * utterance segmentation). To satisfy the `Transcriber` contract's `final`
 * semantics for conversational use, this adapter synthesizes a `final` event
 * when the deltas go quiet for `utteranceSilence`.
 */
import {
  Clock,
  Duration,
  Effect,
  Match,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect"
import { Base64 } from "effect/encoding"
import * as Socket from "effect/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import type { TranscriptEvent } from "@effect-uai/core/Transcript"
import type { CommonStreamTranscribeRequest } from "@effect-uai/core/Transcriber"
import * as WebSocketSession from "@effect-uai/core/WebSocketSession"
import { WebSocket as WSWebSocket } from "ws"

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  /** Target latency knob (`target_streaming_delay_ms`); lower = faster, less accurate. */
  readonly targetStreamingDelay?: Duration.Duration
  /**
   * Silence gap after which the accumulated deltas are committed as a synthetic
   * `final`. Voxtral Realtime does no utterance segmentation, so this is how the
   * adapter delimits turns. Default 700 ms.
   */
  readonly utteranceSilence?: Duration.Duration
  /**
   * Build the socket yourself, for a proxy or an in-memory transport. The
   * default attaches the bearer token through the `ws` package.
   */
  readonly webSocket?: Socket.WebSocketConstructor["Service"]
}

const DEFAULT_SILENCE = Duration.millis(700)

// ---------------------------------------------------------------------------
// AudioFormat gate — Voxtral Realtime ingests pcm_s16le @ 16000 mono only.
// ---------------------------------------------------------------------------

const ensureInputFormat = (format: AudioFormat): Effect.Effect<void, AiError.AiError> =>
  format.container === "raw" && format.encoding === "pcm_s16le" && format.sampleRate === 16000
    ? Effect.void
    : Effect.fail(
        new AiError.Unsupported({
          provider: "mistral",
          capability: "inputFormat",
          reason: `Voxtral Realtime accepts pcm_s16le @ 16000 mono only. Got ${JSON.stringify(format)}.`,
        }),
      )

// ---------------------------------------------------------------------------
// URL + client frame builders
// ---------------------------------------------------------------------------

const buildWsUrl = (cfg: Config, model: string) => {
  const base = (cfg.baseUrl ?? "https://api.mistral.ai").replace(/^http/, "ws")
  return `${base}/v1/audio/transcriptions/realtime?model=${encodeURIComponent(model)}`
}

const sessionUpdateFrame = (cfg: Config) =>
  JSON.stringify({
    type: "session.update",
    session: {
      audio_format: { encoding: "pcm_s16le", sample_rate: 16000 },
      ...(cfg.targetStreamingDelay !== undefined && {
        target_streaming_delay_ms: Duration.toMillis(cfg.targetStreamingDelay),
      }),
    },
  })

const audioAppendFrame = (bytes: Uint8Array) =>
  JSON.stringify({ type: "input_audio.append", audio: Base64.encode(bytes) })

const audioEndFrame = JSON.stringify({ type: "input_audio.end" })

// ---------------------------------------------------------------------------
// Wire schemas (server → client)
// ---------------------------------------------------------------------------

const ServerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session.created") }),
  Schema.Struct({ type: Schema.Literal("session.updated") }),
  Schema.Struct({ type: Schema.Literal("transcription.language") }),
  Schema.Struct({ type: Schema.Literal("transcription.segment") }),
  Schema.Struct({ type: Schema.Literal("transcription.text.delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("transcription.done"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("error"),
    error: Schema.Struct({
      message: Schema.String,
      code: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  }),
])
const decodeServerEvent = Schema.decodeUnknownEffect(ServerEvent)

/** Mutable turn state shared by the frame handler and the silence finalizer. */
type TurnState = {
  readonly text: Ref.Ref<string>
  readonly lastActivityMs: Ref.Ref<number>
}

const takeFinal = (
  state: TurnState,
  override?: string,
): Effect.Effect<TranscriptEvent | undefined> =>
  Effect.gen(function* () {
    const acc = yield* Ref.getAndSet(state.text, "")
    const text = (override !== undefined && override.length > 0 ? override : acc).trim()
    return text.length > 0 ? { _tag: "final", text } : undefined
  })

const frameToEvent =
  (state: TurnState) =>
  (raw: string): Effect.Effect<TranscriptEvent | undefined> =>
    Effect.gen(function* () {
      const json = yield* JSONL.parseSafe(raw)
      if (json === undefined) return undefined
      const decoded = yield* decodeServerEvent(json).pipe(Effect.option)
      if (Option.isNone(decoded)) return undefined
      return yield* Match.value(decoded.value).pipe(
        Match.when({ type: "transcription.text.delta" }, (m) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const next = yield* Ref.updateAndGet(state.text, (t) => t + m.text)
            yield* Ref.set(state.lastActivityMs, now)
            // Cumulative partial so the UI shows the growing sentence.
            return { _tag: "partial", text: next } satisfies TranscriptEvent
          }),
        ),
        // End-of-audio: commit whatever's left as the final utterance.
        Match.when({ type: "transcription.done" }, (m) => takeFinal(state, m.text)),
        Match.when({ type: "error" }, (m) =>
          Effect.succeed<TranscriptEvent>({
            _tag: "error",
            ...(m.error.code != null && { code: String(m.error.code) }),
            message: m.error.message,
          }),
        ),
        // session.created / .updated / language / segment: no user-visible event.
        Match.orElse(() => Effect.succeed(undefined)),
      )
    })

// Commits a synthetic final once the deltas go quiet; checks now, then every 150 ms.
const silenceFinals = (
  state: TurnState,
  silence: Duration.Duration,
): Stream.Stream<TranscriptEvent> => {
  const silenceMs = Duration.toMillis(silence)
  return Stream.tick("150 millis").pipe(
    Stream.mapEffect(() =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const last = yield* Ref.get(state.lastActivityMs)
        const acc = yield* Ref.get(state.text)
        return acc.trim().length > 0 && now - last >= silenceMs
          ? yield* takeFinal(state)
          : undefined
      }),
    ),
    Stream.filter(Predicate.isNotUndefined),
  )
}

// ---------------------------------------------------------------------------
// Stream<Uint8Array> → Stream<TranscriptEvent>
// ---------------------------------------------------------------------------

// `@types/ws`'s WebSocket extends Node's EventEmitter while
// `globalThis.WebSocket` extends EventTarget; the browser-style surface
// Effect's Socket reads (`addEventListener` / `send` / `close`) is identical at
// runtime, hence the single contained cast.
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
        yield* ensureInputFormat(request.inputFormat)
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg, request.model)).pipe(
          Effect.provideService(
            Socket.WebSocketConstructor,
            cfg.webSocket ?? authedWsConstructor(cfg),
          ),
        )
        const state: TurnState = {
          text: yield* Ref.make(""),
          lastActivityMs: yield* Ref.make(0),
        }
        const { write } = yield* socket.writer
        const asAiError = WebSocketSession.toAiError("mistral")

        const frames = Stream.fromPull(Socket.readerString(socket)).pipe(
          Stream.scoped,
          Stream.catchIf(WebSocketSession.isCleanClose, () => Stream.empty),
          Stream.mapError(asAiError),
          Stream.mapEffect(frameToEvent(state)),
          Stream.filter(Predicate.isNotUndefined),
        )
        const events = Stream.merge(
          frames,
          silenceFinals(state, cfg.utteranceSilence ?? DEFAULT_SILENCE),
          { haltStrategy: "left" },
        )

        // session.update first, then base64 PCM, then signal end. Writes wait for the reader to connect.
        const outgoing = Stream.concat(
          Stream.concat(
            Stream.make(sessionUpdateFrame(cfg)),
            Stream.map(audioIn, audioAppendFrame),
          ),
          Stream.make(audioEndFrame),
        ).pipe(Stream.mapEffect((frame) => Effect.mapError(write(frame), asAiError)))

        // The server's close ends the transcript; the audio running out does not.
        return Stream.merge(events, Stream.drain(outgoing), { haltStrategy: "left" })
      }),
    )
