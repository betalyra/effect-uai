import { Context, Effect, Function, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { AudioFormat, AudioSource } from "../domain/Audio.js"
import type { TranscriptEvent, TranscriptResult } from "../domain/Transcript.js"

/**
 * Cross-provider sync transcription request. Provider-specific
 * extensions (Deepgram `keyterm[]`, ElevenLabs `diarize`, Google
 * `adaptation`, …) live on each provider's typed request which extends
 * this and narrows `model`.
 */
export type CommonTranscribeRequest = {
  readonly audio: AudioSource
  /** Model identifier. Each provider narrows to its typed literal union. */
  readonly model: string
  /** ISO-639-1 / BCP-47. Omit for autodetection (where supported). */
  readonly language?: string
  /** Free-form context / style hint (Whisper-style prose). OpenAI honors
   *  it; providers without a prompt field `warnDropped`. */
  readonly prompt?: string
  /** Vocabulary biasing — discrete terms to boost (names, jargon). Maps to
   *  Deepgram `keyterm`, ElevenLabs `keyterms`, Google `adaptation`,
   *  Inworld `prompts`; others `warnDropped`. */
  readonly biasingTerms?: ReadonlyArray<string>
  readonly diarization?: boolean
  readonly wordTimestamps?: boolean
}

/**
 * Streaming-transcription request. `inputFormat` declares what the
 * bytes in the input stream will look like — providers reject
 * formats they can't ingest at stream startup with
 * `AiError.Unsupported` (a per-Layer capability gap, not a wire-shape
 * mismatch).
 */
export type CommonStreamTranscribeRequest = Omit<CommonTranscribeRequest, "audio"> & {
  readonly inputFormat: AudioFormat
  readonly interimResults?: boolean
  readonly vadEvents?: boolean
}

export type TranscriberService = {
  /**
   * One-shot transcription. Universal — AWS Transcribe (which has no
   * native sync endpoint) emulates this by draining a streaming session
   * internally.
   */
  readonly transcribe: (
    request: CommonTranscribeRequest,
  ) => Effect.Effect<TranscriptResult, AiError.AiError>
  /**
   * Live transcription as a Stream transformer. Consumes audio bytes
   * from `audioIn`; emits `TranscriptEvent`s as they arrive. The
   * underlying WS / gRPC connection is acquired on first pull and
   * released when the output stream is finalized (success, failure, or
   * interruption) via `Stream.scoped` — no explicit Scope handling at
   * the call site.
   *
   * Gated by the `SttStreaming` capability marker on the top-level
   * helper — providers without streaming-STT support don't ship the
   * marker, so calls fail at `Effect.provide` with a type error.
   */
  readonly streamTranscriptionFrom: <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ) => Stream.Stream<TranscriptEvent, AiError.AiError | E, R>
}

export class Transcriber extends Context.Service<Transcriber, TranscriberService>()(
  "@betalyra/effect-uai/Transcriber",
) {}

/**
 * Capability marker — provided by provider layers whose
 * `streamTranscriptionFrom` is wired up at the wire level. Azure does
 * not ship it (streaming-STT is SDK-internal). Calling
 * `streamTranscriptionFrom` while only Azure's Layer is in scope fails
 * at `Effect.provide` with a type error, not at runtime.
 *
 * Phantom — the value is `void`; providers register with
 * `Layer.succeed(SttStreaming, undefined)`.
 */
export class SttStreaming extends Context.Service<SttStreaming, void>()(
  "@betalyra/effect-uai/capability/SttStreaming",
) {}

/** One-shot transcription. */
export const transcribe = (
  request: CommonTranscribeRequest,
): Effect.Effect<TranscriptResult, AiError.AiError, Transcriber> =>
  Effect.flatMap(Transcriber.asEffect(), (t) => t.transcribe(request))

/**
 * Live transcription. Dual-arity: pipeable (data-last) and direct
 * (data-first). Requires `SttStreaming` in R — providers without
 * streaming support are a type error at provide time.
 *
 * @example
 * ```ts
 * // Pipeable — composes with other Stream operators
 * mic.frames.pipe(
 *   Transcriber.streamTranscriptionFrom(req),
 *   Stream.filter((e) => e._tag === "final"),
 * )
 *
 * // Direct
 * Transcriber.streamTranscriptionFrom(mic.frames, req)
 * ```
 */
export const streamTranscriptionFrom: {
  (
    request: CommonStreamTranscribeRequest,
  ): <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
  ) => Stream.Stream<TranscriptEvent, AiError.AiError | E, R | Transcriber | SttStreaming>
  <E, R>(
    audioIn: Stream.Stream<Uint8Array, E, R>,
    request: CommonStreamTranscribeRequest,
  ): Stream.Stream<TranscriptEvent, AiError.AiError | E, R | Transcriber | SttStreaming>
} = Function.dual(
  2,
  <E, R>(audioIn: Stream.Stream<Uint8Array, E, R>, request: CommonStreamTranscribeRequest) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const t = yield* Transcriber.asEffect()
        yield* SttStreaming.asEffect()
        return t.streamTranscriptionFrom(audioIn, request)
      }),
    ),
)
