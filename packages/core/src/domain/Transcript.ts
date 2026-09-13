import { Data, type Duration, Effect, Match, Option, Ref, Stream } from "effect"
import * as Settle from "../streaming/Settle.js"

/**
 * Per-word timing + metadata. `confidence` and `speakerId` are optional
 * because providers vary widely in what they emit and when (some only on
 * final, some only with diarization enabled, some not at all).
 *
 * `startSeconds` / `endSeconds` stay raw `number` offsets (not `Duration`)
 * — they're positions in the audio, not durations.
 */
export type WordTimestamp = {
  readonly text: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly confidence?: number
  readonly speakerId?: string
  readonly languageCode?: string
}

/**
 * Sync STT result. `raw` preserves the provider-specific response for
 * consumers that need fields the common shape doesn't expose
 * (alternatives, segments, NBest, audio events, etc.).
 */
export type TranscriptResult = {
  readonly text: string
  readonly languageCode?: string
  /** Total audio duration. (Word offsets stay raw seconds on `WordTimestamp`.) */
  readonly duration?: Duration.Duration
  readonly words?: ReadonlyArray<WordTimestamp>
  readonly raw?: unknown
}

/**
 * Streaming STT event union. Collapses every provider's vocabulary into
 * a small set; provider-specific shapes survive on `metadata.raw`.
 *
 * - `partial`: interim hypothesis. `stability` is Google-only.
 * - `final`: committed transcript for the current utterance / segment.
 * - `speech-started` / `utterance-ended`: VAD-derived boundaries. Not
 *   all providers emit them (OpenAI Realtime, Google with
 *   `voice_activity_events`, Deepgram with `vad_events`, AssemblyAI).
 * - `audio-event`: non-speech label (`(laughter)`, `(music)`) — ElevenLabs only.
 * - `metadata`: opaque server-side bookkeeping (request_id, model info).
 * - `error`: non-fatal provider error mid-stream. Fatal errors surface
 *   on the `Stream`'s error channel as `AiError.AiError`.
 */
export type TranscriptEvent = Data.TaggedEnum<{
  partial: {
    readonly text: string
    readonly words?: ReadonlyArray<WordTimestamp>
    readonly stability?: number
  }
  final: {
    readonly text: string
    readonly words?: ReadonlyArray<WordTimestamp>
    readonly languageCode?: string
  }
  "speech-started": { readonly atSeconds: number }
  "utterance-ended": { readonly atSeconds: number }
  "audio-event": {
    readonly label: string
    readonly startSeconds: number
    readonly endSeconds: number
  }
  metadata: { readonly raw: unknown }
  error: { readonly code?: string; readonly message: string }
}>

export const TranscriptEvent = Data.taggedEnum<TranscriptEvent>()

/**
 * `TranscriptEvent.$is(tag)` is the same guard and takes `unknown`, which is
 * what a stream operator scanning a mixed stream needs. These stay for the
 * call sites that read better named.
 */
export const isPartial = TranscriptEvent.$is("partial")
export const isFinal = TranscriptEvent.$is("final")
export const isSpeechStarted = TranscriptEvent.$is("speech-started")
export const isUtteranceEnded = TranscriptEvent.$is("utterance-ended")
export const isAudioEvent = TranscriptEvent.$is("audio-event")
export const isMetadata = TranscriptEvent.$is("metadata")
export const isError = TranscriptEvent.$is("error")

export type AccumulatePartialsOptions = {
  /** Silence after the last `partial` before the text so far is committed. */
  readonly silence?: Duration.Input
}

const DEFAULT_SILENCE = "700 millis"

const finalOf = (text: string): Option.Option<TranscriptEvent> =>
  text.trim().length === 0 ? Option.none() : Option.some({ _tag: "final", text: text.trim() })

/**
 * Join fragment `partial`s into the running hypothesis and commit it as a
 * `final` after `silence`. For providers that stream token-sized deltas
 * (OpenAI Realtime) or never segment; piping one that already accumulates
 * repeats its text.
 *
 * Partials are forwarded as they arrive; only the synthetic `final` waits.
 * A real `final` resets the accumulator, and the stream end flushes it.
 */
export const accumulatePartials =
  (options?: AccumulatePartialsOptions) =>
  <E, R>(self: Stream.Stream<TranscriptEvent, E, R>): Stream.Stream<TranscriptEvent, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const acc = yield* Ref.make("")
        const flush = Effect.map(Ref.getAndSet(acc, ""), finalOf)

        const rewrite = (event: TranscriptEvent): Effect.Effect<TranscriptEvent> =>
          Match.value(event).pipe(
            Match.when({ _tag: "partial" }, (e) =>
              Effect.map(
                Ref.updateAndGet(acc, (text) => text + e.text),
                (text): TranscriptEvent => ({ ...e, text: text.trim() }),
              ),
            ),
            Match.when({ _tag: "final" }, (e) => Effect.as(Ref.set(acc, ""), e as TranscriptEvent)),
            Match.orElse((e) => Effect.succeed(e as TranscriptEvent)),
          )

        return self.pipe(
          Stream.mapEffect(rewrite),
          Settle.onQuiet(options?.silence ?? DEFAULT_SILENCE, flush),
          Stream.concat(
            Stream.unwrap(
              Effect.map(flush, Option.match({ onNone: () => Stream.empty, onSome: Stream.make })),
            ),
          ),
        )
      }),
    )
