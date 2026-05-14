/**
 * Inworld TTS models (current per [docs.inworld.ai/tts/tts](https://docs.inworld.ai/tts/tts)).
 *
 * - `inworld-tts-2` — flagship, 100+ languages, supports `deliveryMode` style
 *   steering (`STABLE` / `BALANCED` / `CREATIVE`). ~200ms P50.
 * - `inworld-tts-1.5-max` — 15 languages, ~200ms P50.
 * - `inworld-tts-1.5-mini` — 15 languages, ~120ms P50, lowest latency.
 *
 * `inworld-tts-1` / `inworld-tts-1-max` are not in current docs — treat as
 * superseded. The `(string & {})` tail keeps autocomplete on literals while
 * accepting any string so newly-released models work without an SDK update.
 */
export type InworldTtsModel =
  | "inworld-tts-2"
  | "inworld-tts-1.5-max"
  | "inworld-tts-1.5-mini"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Inworld voice ID. Inworld voices are human-readable names ("Sarah",
 * "Edward", …) but there's no public list-voices REST endpoint — voices
 * are browsed via the Inworld Portal. Typing this as `string` rather than
 * a hard-coded union avoids the union rotting between SDK releases.
 */
export type InworldVoiceId = string

/**
 * Inworld STT models. `inworld/inworld-stt-1` is the first-party model
 * (marked Experimental in docs at time of writing). The rest are
 * router-style passthroughs — Inworld proxies to the named provider
 * behind their auth & billing.
 *
 * Streaming WS support varies: `inworld/inworld-stt-1` and AssemblyAI /
 * Soniox variants support both sync + WS; Groq Whisper is sync-only.
 */
export type InworldSttModel =
  | "inworld/inworld-stt-1"
  | "groq/whisper-large-v3"
  | "assemblyai/universal-streaming-english"
  | "assemblyai/universal-streaming-multilingual"
  | "assemblyai/u3-rt-pro"
  | "assemblyai/whisper-rt"
  | "soniox/stt-rt-v4"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * `deliveryMode` style steering — only honored by `inworld-tts-2`. Older
 * models ignore the field silently.
 */
export type InworldDeliveryMode = "STABLE" | "BALANCED" | "CREATIVE"

/**
 * Inworld's `audioEncoding` enum (TTS audioConfig).
 *
 * Note: sync `LINEAR16` / `WAV` responses include a WAV header in the
 * `audioContent` bytes. Streaming (NDJSON + WS) chunks do **not**. The
 * codec layer surfaces this difference in `AudioFormat.container`.
 */
export type InworldAudioEncoding =
  | "LINEAR16"
  | "MP3"
  | "OGG_OPUS"
  | "ALAW"
  | "MULAW"
  | "FLAC"
  | "PCM"
  | "WAV"
