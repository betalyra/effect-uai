/**
 * Known ElevenLabs TTS model identifiers (as of mid-2026). The
 * `(string & {})` tail keeps autocomplete on the literals while still
 * accepting any string, so newly-released models work without an SDK
 * update.
 *
 * - `eleven_v3` — most expressive; supports inline audio-tag emotion
 *   directives (`<laugh>`, `<whisper>`, etc.). 70+ languages.
 * - `eleven_multilingual_v2` — production-grade multilingual. 29
 *   languages. Default for the API.
 * - `eleven_turbo_v2_5` — low latency, 32 languages.
 * - `eleven_flash_v2_5` — sub-100 ms first-byte, 32 languages.
 *
 * Reference: https://elevenlabs.io/docs/overview/models
 */
export type ElevenLabsTtsModel =
  | "eleven_v3"
  | "eleven_multilingual_v2"
  | "eleven_turbo_v2_5"
  | "eleven_flash_v2_5"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Known ElevenLabs STT model identifiers.
 *
 * - `scribe_v2` — current generation, recommended.
 * - `scribe_v1` — legacy.
 * - `scribe_v2_realtime` — WebSocket streaming variant (Phase 2b).
 *
 * Reference: https://elevenlabs.io/docs/api-reference/speech-to-text
 */
export type ElevenLabsSttModel =
  | "scribe_v2"
  | "scribe_v1"
  | "scribe_v2_realtime"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * ElevenLabs voice IDs are 20-character alphanumeric strings (e.g.
 * `JBFqnCBsd6RMkjVDRZzb`). Both stock and cloned voices use the same
 * opaque format, so there's no useful literal narrowing here — the
 * full catalog is fetched dynamically via `GET /v1/voices`.
 */
export type ElevenLabsVoiceId = string
