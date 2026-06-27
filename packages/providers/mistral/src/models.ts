/**
 * Known Mistral model identifiers usable via the chat-completions API (as of
 * mid-2026). The `(string & {})` tail keeps autocomplete on the literals while
 * still accepting any string, so newly-released models work without an SDK
 * update.
 *
 * Reference: https://docs.mistral.ai/getting-started/models/models_overview
 *
 * Prefer the `-latest` aliases for evergreen pins; the dated snapshots are
 * available when you need a frozen version.
 */
export type MistralModel =
  | "mistral-large-latest"
  | "mistral-medium-latest"
  | "mistral-small-latest"
  | "magistral-medium-latest"
  | "magistral-small-latest"
  | "ministral-8b-latest"
  | "ministral-3b-latest"
  | "open-mistral-nemo"
  | "codestral-latest"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

// ---------------------------------------------------------------------------
// Voxtral audio models (Mistral's STT / TTS family)
// Reference: https://docs.mistral.ai/studio-api/audio/overview
// ---------------------------------------------------------------------------

/** Batch / offline transcription models. */
export type MistralTranscribeModel =
  | "voxtral-mini-latest"
  | "voxtral-mini-2507"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/** Realtime (streaming) transcription models. */
export type MistralRealtimeModel =
  | "voxtral-mini-transcribe-realtime-2602"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/** Text-to-speech models. */
export type MistralTtsModel =
  | "voxtral-mini-tts-2603"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
