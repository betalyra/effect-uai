import { Context, Effect, Function, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { AudioBlob, AudioChunk, AudioFormat } from "../domain/Audio.js"

/**
 * Per-phrase pronunciation override. `pronunciation` is always IPA, the
 * universal phonetic interchange format. Adapters translate to the
 * provider's wire form (inline `/ipa/` token, SSML `<phoneme>`, or a
 * structured field), converting IPA to X-SAMPA internally where the wire
 * requires it (Google, Azure).
 *
 * Pronunciations are load-bearing (the configured word is mispronounced
 * if dropped), so a provider with no stateless IPA path fails the call
 * with `AiError.Unsupported` rather than silently degrading.
 */
export type CustomPronunciation = {
  readonly phrase: string
  /** IPA notation, e.g. `"ænˈθrɒpɪk"`. */
  readonly pronunciation: string
}

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
  /**
   * IPA phoneme overrides for specific phrases. Adapters render them to
   * the provider's wire form (inline token, SSML `<phoneme>`, structured
   * field). Load-bearing: a provider with no stateless IPA path fails
   * the call with `AiError.Unsupported` rather than mispronouncing.
   */
  readonly pronunciations?: ReadonlyArray<CustomPronunciation>
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

/**
 * One turn in a multi-speaker dialogue. Just a voice and its line; the
 * only in-tree dialogue endpoint (ElevenLabs `/v1/text-to-dialogue`)
 * accepts `{ voice_id, text }` per turn. Per-turn styling knobs
 * (Hume Octave-2 `styleDescription` / `speed`) are provider-specific
 * and belong on a provider-typed turn extension, not here.
 */
export type DialogueTurn = {
  readonly voiceId: string
  readonly text: string
}

/**
 * Cross-provider dialogue request. Same return type as `synthesize` —
 * one continuous `AudioBlob`. Per-turn timing metadata is not exposed
 * in the common shape (only Hume returns it natively).
 */
export type CommonSynthesizeDialogueRequest = {
  readonly model: string
  readonly turns: ReadonlyArray<DialogueTurn>
  readonly outputFormat?: AudioFormat
  readonly languageCode?: string
  readonly pronunciations?: ReadonlyArray<CustomPronunciation>
}

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
  /**
   * One-shot multi-speaker dialogue. Turn array in, single `AudioBlob`
   * out. Providers without native dialogue support return
   * `AiError.Unsupported` and do NOT ship the `MultiSpeakerTts` marker
   * — calls via the top-level helper become a compile-time error.
   */
  readonly synthesizeDialogue: (
    request: CommonSynthesizeDialogueRequest,
  ) => Effect.Effect<AudioBlob, AiError.AiError>
  /**
   * Chunked-streaming variant of `synthesizeDialogue`. Same input,
   * audio chunks emitted as the wire delivers them. Providers that
   * synthesize the whole dialogue server-side may fall back to a
   * single-chunk wrap of the sync result.
   *
   * Gated by `MultiSpeakerTts` at the top-level helper.
   */
  readonly streamSynthesizeDialogue: (
    request: CommonSynthesizeDialogueRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError>
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

/**
 * Capability marker for multi-speaker dialogue. Shipped by provider
 * Layers whose `synthesizeDialogue` is wired to a native multi-speaker
 * endpoint (ElevenLabs `/v1/text-to-dialogue`, Hume `/v0/tts` with
 * `utterances[]`, Google Cloud TTS Gemini TTS `multiSpeakerMarkup`).
 * Other providers leave the marker unregistered so the top-level
 * `synthesizeDialogue` / `streamSynthesizeDialogue` helpers fail to
 * satisfy R against those Layers — compile-time error.
 */
export class MultiSpeakerTts extends Context.Service<MultiSpeakerTts, void>()(
  "@betalyra/effect-uai/capability/MultiSpeakerTts",
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

/**
 * One-shot multi-speaker dialogue. Requires `MultiSpeakerTts` in R —
 * providers without dialogue support are a compile-time error.
 */
export const synthesizeDialogue = (
  request: CommonSynthesizeDialogueRequest,
): Effect.Effect<AudioBlob, AiError.AiError, SpeechSynthesizer | MultiSpeakerTts> =>
  Effect.gen(function* () {
    const s = yield* SpeechSynthesizer.asEffect()
    yield* MultiSpeakerTts.asEffect()
    return yield* s.synthesizeDialogue(request)
  })

/**
 * Chunked-streaming variant. Same R requirement as `synthesizeDialogue`.
 */
export const streamSynthesizeDialogue = (
  request: CommonSynthesizeDialogueRequest,
): Stream.Stream<AudioChunk, AiError.AiError, SpeechSynthesizer | MultiSpeakerTts> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const s = yield* SpeechSynthesizer.asEffect()
      yield* MultiSpeakerTts.asEffect()
      return s.streamSynthesizeDialogue(request)
    }),
  )
