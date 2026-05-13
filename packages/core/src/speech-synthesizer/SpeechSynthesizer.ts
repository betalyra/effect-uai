import { Context, Effect, Function, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { AudioBlob, AudioChunk, AudioFormat } from "../domain/Audio.js"

/**
 * Cross-provider synthesis request. Provider-specific extensions
 * (ElevenLabs `stability` / `similarity_boost`, Cartesia `emotion`,
 * MiniMax `vol` / `pitch`, Azure SSML style tags) live on each
 * provider's typed request which extends this and narrows `model` and
 * `voiceId`.
 */
export type CommonSynthesizeRequest = {
  readonly text: string
  /** Model identifier. Each provider narrows. */
  readonly model: string
  /**
   * Voice identifier. Per-provider request types narrow this to a
   * typed literal union of stock voices + `(string & {})` escape for
   * custom cloned voice IDs. Providers without custom-voice support
   * (OpenAI, Deepgram Aura, AWS Polly) narrow to the stock-only union.
   */
  readonly voiceId: string
  readonly outputFormat?: AudioFormat
  readonly speed?: number
  readonly languageCode?: string
}

/**
 * Incremental-synthesis request — text arrives as `Stream<string>`.
 * Gated by the `TtsIncrementalText` capability marker; only providers
 * that ship the marker can be used.
 *
 * Multi-context features (Cartesia `context_id`, ElevenLabs `multi-
 * stream-input`) are NOT exposed here — one logical utterance per
 * call. Provider extensions can expose `forkContext` for that.
 */
export type CommonStreamSynthesizeRequest = Omit<CommonSynthesizeRequest, "text">

export type SpeechSynthesizerService = {
  /** One-shot. Full text in, full audio bytes out. Universally supported. */
  readonly synthesize: (
    request: CommonSynthesizeRequest,
  ) => Effect.Effect<AudioBlob, AiError.AiError>
  /**
   * Full text in, audio chunks streamed out (chunked HTTP). Universally
   * supported across providers that offer any streaming TTS at all.
   */
  readonly streamSynthesis: (
    request: CommonSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
  /**
   * Incremental text in (as a Stream), audio chunks streamed out. The
   * underlying WS connection is acquired on first pull and released
   * when the output stream is finalized via `Stream.scoped`.
   *
   * Gated by the `TtsIncrementalText` capability marker on the top-
   * level helper — providers without WS-style incremental input don't
   * ship the marker, so calls fail at `Effect.provide` with a type
   * error.
   */
  readonly streamSynthesisFrom: <E, R>(
    textIn: Stream.Stream<string, E, R>,
    request: CommonStreamSynthesizeRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R>
}

export class SpeechSynthesizer extends Context.Service<
  SpeechSynthesizer,
  SpeechSynthesizerService
>()("@betalyra/effect-uai/SpeechSynthesizer") {}

/**
 * Capability marker — provided by provider layers whose
 * `streamSynthesisFrom` is wired up at the wire level. OpenAI, Azure
 * (wire), and AWS Polly non-Generative do not ship it. Calling
 * `streamSynthesisFrom` while only one of those Layers is in scope
 * fails at `Effect.provide` with a type error.
 *
 * Phantom — the value is `void`; providers register with
 * `Layer.succeed(TtsIncrementalText, undefined)`.
 */
export class TtsIncrementalText extends Context.Service<TtsIncrementalText, void>()(
  "@betalyra/effect-uai/capability/TtsIncrementalText",
) {}

/** One-shot synthesis. */
export const synthesize = (
  request: CommonSynthesizeRequest,
): Effect.Effect<AudioBlob, AiError.AiError, SpeechSynthesizer> =>
  Effect.flatMap(SpeechSynthesizer.asEffect(), (s) => s.synthesize(request))

/** Full text in, audio chunks out. */
export const streamSynthesis = (
  request: CommonSynthesizeRequest,
): Stream.Stream<AudioChunk, AiError.AiError, SpeechSynthesizer> =>
  Stream.unwrap(Effect.map(SpeechSynthesizer.asEffect(), (s) => s.streamSynthesis(request)))

/**
 * Incremental synthesis. Dual-arity: pipeable (data-last) and direct
 * (data-first). Requires `TtsIncrementalText` in R — providers without
 * incremental-text-in support are a type error at provide time.
 *
 * @example
 * ```ts
 * const audio = LanguageModel.streamTurn(turnReq).pipe(
 *   Stream.filterMap(Turn.toTextDelta),
 *   SpeechSynthesizer.streamSynthesisFrom(synthReq),
 * )
 * ```
 */
export const streamSynthesisFrom: {
  (
    request: CommonStreamSynthesizeRequest,
  ): <E, R>(
    textIn: Stream.Stream<string, E, R>,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R | SpeechSynthesizer | TtsIncrementalText>
  <E, R>(
    textIn: Stream.Stream<string, E, R>,
    request: CommonStreamSynthesizeRequest,
  ): Stream.Stream<AudioChunk, AiError.AiError | E, R | SpeechSynthesizer | TtsIncrementalText>
} = Function.dual(
  2,
  <E, R>(textIn: Stream.Stream<string, E, R>, request: CommonStreamSynthesizeRequest) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const s = yield* SpeechSynthesizer.asEffect()
        yield* TtsIncrementalText.asEffect()
        return s.streamSynthesisFrom(textIn, request)
      }),
    ),
)
