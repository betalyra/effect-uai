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
  Cause,
  Clock,
  Duration,
  Effect,
  Encoding,
  Match,
  Queue,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as JSONL from "@effect-uai/core/JSONL"
import type { TranscriptEvent } from "@effect-uai/core/Transcript"
import type { CommonStreamTranscribeRequest } from "@effect-uai/core/Transcriber"
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
  JSON.stringify({ type: "input_audio.append", audio: Encoding.encodeBase64(bytes) })

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

/** Mutable turn state shared by the message handler and the silence finalizer. */
type TurnState = {
  readonly text: Ref.Ref<string>
  readonly lastActivityMs: Ref.Ref<number>
}

const emitFinal = (
  queue: Queue.Queue<TranscriptEvent, Cause.Done>,
  state: TurnState,
  override?: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const acc = yield* Ref.getAndSet(state.text, "")
    const text = (override !== undefined && override.length > 0 ? override : acc).trim()
    if (text.length > 0) yield* Queue.offer(queue, { _tag: "final", text })
  })

const handleServerMessage =
  (queue: Queue.Queue<TranscriptEvent, Cause.Done>, state: TurnState) => (raw: string) =>
    Effect.gen(function* () {
      const json = yield* JSONL.parseSafe(raw)
      if (json === undefined) return
      const decoded = yield* decodeServerEvent(json).pipe(Effect.option)
      if (decoded._tag === "None") return
      yield* Match.value(decoded.value).pipe(
        Match.when({ type: "transcription.text.delta" }, (m) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const next = yield* Ref.updateAndGet(state.text, (t) => t + m.text)
            yield* Ref.set(state.lastActivityMs, now)
            // Cumulative partial so the UI shows the growing sentence.
            yield* Queue.offer(queue, { _tag: "partial", text: next })
          }),
        ),
        // End-of-audio: commit whatever's left as the final utterance.
        Match.when({ type: "transcription.done" }, (m) => emitFinal(queue, state, m.text)),
        Match.when({ type: "error" }, (m) =>
          Queue.offer(queue, {
            _tag: "error",
            ...(m.error.code != null && { code: String(m.error.code) }),
            message: m.error.message,
          }),
        ),
        // session.created / .updated / language / segment: no user-visible event.
        Match.orElse(() => Effect.void),
      )
    })

// Background loop: commit a synthetic final once the deltas go quiet.
const silenceFinalizer = (
  queue: Queue.Queue<TranscriptEvent, Cause.Done>,
  state: TurnState,
  silence: Duration.Duration,
): Effect.Effect<never> => {
  const silenceMs = Duration.toMillis(silence)
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const last = yield* Ref.get(state.lastActivityMs)
    const acc = yield* Ref.get(state.text)
    if (acc.trim().length > 0 && now - last >= silenceMs) yield* emitFinal(queue, state)
    yield* Effect.sleep("150 millis")
  }).pipe(Effect.forever)
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
        const socket = yield* Socket.makeWebSocket(buildWsUrl(cfg, request.model), {
          // Effect's Socket treats all close codes as errors by default —
          // whitelist standard clean-close codes (1000 / 1001 / 1005).
          closeCodeIsError: (code) => code !== 1000 && code !== 1001 && code !== 1005,
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, authedWsConstructor(cfg)))
        const queue = yield* Queue.bounded<TranscriptEvent, Cause.Done>(64)
        const state: TurnState = {
          text: yield* Ref.make(""),
          lastActivityMs: yield* Ref.make(0),
        }
        const write = yield* socket.writer

        // session.update first, then stream base64 PCM frames, then signal end.
        // Fork-scoped so the Stream's downstream scope tears them down on
        // disconnect / cancel.
        yield* Effect.gen(function* () {
          yield* write(sessionUpdateFrame(cfg))
          yield* Stream.runForEach(audioIn, (bytes) => write(audioAppendFrame(bytes)))
          yield* write(audioEndFrame)
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("[voxtral-realtime] audio send failed", { cause }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        )

        yield* silenceFinalizer(queue, state, cfg.utteranceSilence ?? DEFAULT_SILENCE).pipe(
          Effect.forkScoped,
        )

        // `Queue.end` flushes pending events then ends the stream cleanly;
        // `Queue.shutdown` would drop queued items and interrupt takes. A
        // connection/read failure is logged (otherwise the stream would end
        // silently with no transcripts).
        yield* socket.runString(handleServerMessage(queue, state)).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("[voxtral-realtime] socket closed", { cause }),
          ),
          Effect.ensuring(Queue.end(queue)),
          Effect.forkScoped,
        )

        return Stream.fromQueue(queue)
      }),
    )
