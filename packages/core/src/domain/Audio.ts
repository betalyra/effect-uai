import type { Duration } from "effect"
import type { MediaBase64, MediaBytes, MediaUrl } from "./Media.js"

/**
 * MIME types we care about across STT input and TTS output. Container-
 * level only — sample rate / encoding flavours live on `AudioFormat`.
 *
 * Per-provider request types narrow this further. The `(string & {})`
 * tail keeps autocomplete on the literals while still accepting any
 * string, so unusual formats work without an SDK update.
 */
export type AudioMimeType =
  | "audio/mpeg"
  | "audio/wav"
  | "audio/x-wav"
  | "audio/ogg"
  | "audio/opus"
  | "audio/flac"
  | "audio/aac"
  | "audio/mp4"
  | "audio/webm"
  | "audio/L16"
  | "audio/pcm"
  | "audio/mulaw"
  | "audio/alaw"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Audio at rest — instantiates `MediaSource` with the audio MIME union.
 * Used for sync STT input.
 *
 * URL variant is best-effort: some providers (OpenAI, Cartesia, Azure
 * short-audio) reject URL ingestion and the adapter must upload via the
 * `bytes` or `base64` variant instead. Adapter layers reject unsupported
 * shapes up front with `AiError.InvalidRequest`.
 */
export type AudioSource =
  | MediaUrl<AudioMimeType>
  | MediaBase64<AudioMimeType>
  | MediaBytes<AudioMimeType>

export const isAudioUrl = (s: AudioSource): s is MediaUrl<AudioMimeType> => s._tag === "url"
export const isAudioBase64 = (s: AudioSource): s is MediaBase64<AudioMimeType> =>
  s._tag === "base64"
export const isAudioBytes = (s: AudioSource): s is MediaBytes<AudioMimeType> => s._tag === "bytes"

/**
 * Structural audio format. Used both as TTS output spec and as STT
 * streaming-input declaration. Providers that use compound slugs
 * (`mp3_44100_128`, `audio-16khz-128kbitrate-mono-mp3`,
 * `aura-2-thalia-en`) are encoded at the adapter layer.
 */
export type AudioFormat = {
  readonly container: "mp3" | "wav" | "ogg" | "opus" | "flac" | "aac" | "webm" | "raw"
  readonly encoding:
    | "pcm_s16le"
    | "pcm_f32le"
    | "pcm_mulaw"
    | "pcm_alaw"
    | "mp3"
    | "opus"
    | "vorbis"
    | "flac"
    | "aac"
  readonly sampleRate: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000
  /** mp3 / opus only. */
  readonly bitRate?: number
  readonly channels?: 1 | 2
}

/**
 * Streamed audio chunk. `bytes` carries the codec-encoded payload as
 * declared on the stream's `AudioFormat`. No per-chunk timestamp here —
 * providers that emit timing do so via `TranscriptEvent.words[]`.
 */
export type AudioChunk = {
  readonly bytes: Uint8Array
}

/**
 * Full audio result for sync TTS. Format mirrors the request; provider
 * layers normalize.
 */
export type AudioBlob = {
  readonly format: AudioFormat
  readonly bytes: Uint8Array
  readonly duration?: Duration.Duration
}
