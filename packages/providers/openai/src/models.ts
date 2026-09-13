/**
 * OpenAI speech-to-text models.
 *
 * - `gpt-transcribe`: current sync model (`/audio/transcriptions`), also
 *   accepted by Realtime transcription sessions.
 * - `gpt-live-transcribe`: current streaming model (Realtime transcription
 *   sessions), recommended for `streamTranscriptionFrom`.
 * - `gpt-realtime-whisper`: streaming Whisper, Realtime sessions only.
 * - `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`: deprecated
 *   2026-08-26, shutdown 2027-02-26. Only `whisper-1` supports
 *   `verbose_json` (word timestamps via `timestamp_granularities`).
 *
 * The `(string & {})` tail keeps autocomplete on the literals while
 * accepting any string, so newly-released models work without an SDK
 * update.
 *
 * Reference: https://developers.openai.com/api/docs/guides/speech-to-text
 */
export type OpenAITranscribeModel =
  | "gpt-transcribe"
  | "gpt-live-transcribe"
  | "gpt-realtime-whisper"
  | "gpt-4o-transcribe"
  | "gpt-4o-mini-transcribe"
  | "whisper-1"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * OpenAI speech-to-speech models for the Realtime API. `gpt-realtime` and
 * `gpt-realtime-mini` are deprecated (shutdown 2027-01-20); `gpt-realtime-2`
 * and `gpt-realtime-1.5` are still served but superseded.
 *
 * `gpt-live-1` is a different product on `/v1/live/sessions` and is not
 * reachable through this adapter.
 *
 * Reference: https://developers.openai.com/api/docs/models/gpt-realtime-2.1
 */
export type OpenAIRealtimeModel =
  | "gpt-realtime-2.1"
  | "gpt-realtime-2.1-mini"
  | "gpt-realtime-2"
  | "gpt-realtime-1.5"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * OpenAI text-to-speech models.
 *
 * - `gpt-4o-mini-tts` — current steerable model; supports `instructions`
 *   for free-form tone/emotion/pacing control.
 * - `tts-1` / `tts-1-hd` — legacy models; no `instructions`.
 *
 * Reference: https://platform.openai.com/docs/guides/text-to-speech
 */
export type OpenAITtsModel =
  | "gpt-4o-mini-tts"
  | "tts-1"
  | "tts-1-hd"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * OpenAI image models. `gpt-image-2` is the alias, tracking whichever
 * snapshot is current.
 *
 * The `(string & {})` tail keeps autocomplete on the literals while
 * accepting any string, so a newly-released model, or a model id served
 * by a gateway on the same wire protocol, works without an SDK update.
 *
 * Reference: https://developers.openai.com/api/docs/models/gpt-image-2
 */
export type OpenAIImageModel =
  | "gpt-image-2"
  | "gpt-image-2-2026-04-21"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * OpenAI stock voices for TTS. No custom voice cloning is available on
 * the public API — these are the full set. `ballad`, `coral`, and
 * `verse` are `gpt-4o-mini-tts`-only.
 *
 * Reference: https://platform.openai.com/docs/guides/text-to-speech
 */
export type OpenAIVoiceId =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "fable"
  | "onyx"
  | "nova"
  | "sage"
  | "shimmer"
  | "verse"
// No `(string & {})` — there is no custom-voice path for OpenAI.
