/**
 * Per-word timing + metadata. `confidence` and `speakerId` are optional
 * because providers vary widely in what they emit and when (some only on
 * final, some only with diarization enabled, some not at all).
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
  readonly durationSeconds?: number
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
export type TranscriptEvent =
  | {
      readonly _tag: "partial"
      readonly text: string
      readonly words?: ReadonlyArray<WordTimestamp>
      readonly stability?: number
    }
  | {
      readonly _tag: "final"
      readonly text: string
      readonly words?: ReadonlyArray<WordTimestamp>
      readonly languageCode?: string
    }
  | { readonly _tag: "speech-started"; readonly atSeconds: number }
  | { readonly _tag: "utterance-ended"; readonly atSeconds: number }
  | {
      readonly _tag: "audio-event"
      readonly label: string
      readonly startSeconds: number
      readonly endSeconds: number
    }
  | { readonly _tag: "metadata"; readonly raw: unknown }
  | { readonly _tag: "error"; readonly code?: string; readonly message: string }

export const isPartial = (
  e: TranscriptEvent,
): e is Extract<TranscriptEvent, { _tag: "partial" }> => e._tag === "partial"
export const isFinal = (e: TranscriptEvent): e is Extract<TranscriptEvent, { _tag: "final" }> =>
  e._tag === "final"
export const isSpeechStarted = (
  e: TranscriptEvent,
): e is Extract<TranscriptEvent, { _tag: "speech-started" }> => e._tag === "speech-started"
export const isUtteranceEnded = (
  e: TranscriptEvent,
): e is Extract<TranscriptEvent, { _tag: "utterance-ended" }> => e._tag === "utterance-ended"
export const isAudioEvent = (
  e: TranscriptEvent,
): e is Extract<TranscriptEvent, { _tag: "audio-event" }> => e._tag === "audio-event"
export const isMetadata = (
  e: TranscriptEvent,
): e is Extract<TranscriptEvent, { _tag: "metadata" }> => e._tag === "metadata"
export const isError = (e: TranscriptEvent): e is Extract<TranscriptEvent, { _tag: "error" }> =>
  e._tag === "error"
