/**
 * OpenAI speech-to-text models. `gpt-4o-transcribe` and
 * `gpt-4o-mini-transcribe` are the current GPT-family transcription
 * models; `whisper-1` is the legacy Whisper model.
 *
 * Only `whisper-1` supports `verbose_json` (and therefore word/segment
 * timestamps via `timestamp_granularities`).
 *
 * The `(string & {})` tail keeps autocomplete on the literals while
 * accepting any string, so newly-released models work without an SDK
 * update.
 *
 * Reference: https://platform.openai.com/docs/guides/speech-to-text
 */
export type OpenAITranscribeModel =
  | "gpt-4o-transcribe"
  | "gpt-4o-mini-transcribe"
  | "whisper-1"
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
