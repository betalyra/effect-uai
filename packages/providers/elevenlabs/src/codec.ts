import { Array as Arr, Effect, Encoding, Match, Option, Result } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat, AudioSource } from "@effect-uai/core/Audio"

// ---------------------------------------------------------------------------
// Shared TTS voice-settings shape (sync + streaming use the same fields)
// ---------------------------------------------------------------------------

export type VoiceSettings = {
  readonly stability?: number
  readonly similarityBoost?: number
  readonly style?: number
  readonly useSpeakerBoost?: boolean
  readonly speed?: number
}

export const wireVoiceSettings = (v: VoiceSettings | undefined) =>
  v === undefined
    ? undefined
    : {
        ...(v.stability !== undefined && { stability: v.stability }),
        ...(v.similarityBoost !== undefined && { similarity_boost: v.similarityBoost }),
        ...(v.style !== undefined && { style: v.style }),
        ...(v.useSpeakerBoost !== undefined && { use_speaker_boost: v.useSpeakerBoost }),
        ...(v.speed !== undefined && { speed: v.speed }),
      }

/**
 * Best-effort JSON parse. Returns the parsed value or `undefined` on
 * malformed input — both realtime helpers want to skip non-JSON
 * frames silently rather than fail the whole session.
 */
export const parseJson = (raw: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))

// ---------------------------------------------------------------------------
// AudioFormat → ElevenLabs `output_format` query value
// ---------------------------------------------------------------------------

/**
 * ElevenLabs encodes container + sample rate + bitrate in a single
 * dot-less slug (`mp3_44100_128`, `pcm_16000`, `wav_48000`, `ulaw_8000`,
 * `opus_48000_128`, etc.). This helper inverts the common cases of our
 * `AudioFormat` shape into that slug.
 *
 * Only the formats that map cleanly are produced. Anything we can't
 * encode (mismatched bitrate, unsupported sample rate combination)
 * fails `Unsupported` with the requested format echoed so the user can
 * fix it.
 */
export const formatToOutputSlug: (format: AudioFormat) => Effect.Effect<string, AiError.AiError> = (
  format,
) =>
  Match.value(format).pipe(
    Match.when(
      { container: "mp3" },
      (f) => Effect.succeed(`mp3_${f.sampleRate}_${f.bitRate ?? 128}`),
    ),
    Match.when({ container: "opus" }, (f) => Effect.succeed(`opus_${f.sampleRate}_${f.bitRate ?? 128}`)),
    Match.when({ container: "wav" }, (f) => Effect.succeed(`wav_${f.sampleRate}`)),
    Match.when(
      { container: "raw", encoding: "pcm_s16le" },
      (f) => Effect.succeed(`pcm_${f.sampleRate}`),
    ),
    Match.when(
      { container: "raw", encoding: "pcm_mulaw" },
      (f) => Effect.succeed(`ulaw_${f.sampleRate}`),
    ),
    Match.when(
      { container: "raw", encoding: "pcm_alaw" },
      (f) => Effect.succeed(`alaw_${f.sampleRate}`),
    ),
    Match.orElse((f) =>
      Effect.fail(
        new AiError.Unsupported({
          provider: "elevenlabs",
          capability: "outputFormat",
          reason: `Cannot encode ${JSON.stringify(f)} as ElevenLabs output_format. Supported: mp3 + (22050|44100), opus 48000, wav 48000, pcm/ulaw/alaw at any sample rate.`,
        }),
      ),
    ),
  )

/** Default output: 128 kbps MP3 at 44.1 kHz. */
export const defaultFormat: AudioFormat = {
  container: "mp3",
  encoding: "mp3",
  sampleRate: 44100,
  bitRate: 128,
}

// ---------------------------------------------------------------------------
// AudioSource → Blob (STT multipart upload)
// ---------------------------------------------------------------------------

const urlNotSupported: AiError.AiError = new AiError.InvalidRequest({
  provider: "elevenlabs",
  param: "audio",
  raw: 'ElevenLabs accepts URLs via the `cloud_storage_url` field, not the `file` field. Fetch the URL yourself and pass `{ _tag: "bytes", bytes, mimeType }` to use the inline path.',
})

const decodeBase64ToBytes = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(
        new AiError.InvalidRequest({ provider: "elevenlabs", param: "audio", raw: cause }),
      ),
  })

const bytesToBlob = (bytes: Uint8Array, mimeType: string): Blob =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType })

export const audioToBlob: (audio: AudioSource) => Effect.Effect<Blob, AiError.AiError> =
  Match.type<AudioSource>().pipe(
    Match.tag("bytes", (a) => Effect.succeed(bytesToBlob(a.bytes, a.mimeType))),
    Match.tag("base64", (a) =>
      decodeBase64ToBytes(a.base64).pipe(Effect.map((bytes) => bytesToBlob(bytes, a.mimeType))),
    ),
    Match.tag("url", () => Effect.fail(urlNotSupported)),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// MIME → file extension (for the multipart `filename` field)
// ---------------------------------------------------------------------------

const EXTENSION_BY_MIME: ReadonlyArray<readonly [string, string]> = [
  ["mpeg", "mp3"],
  ["mp3", "mp3"],
  ["wav", "wav"],
  ["ogg", "ogg"],
  ["opus", "ogg"],
  ["flac", "flac"],
  ["aac", "aac"],
  ["mp4", "m4a"],
  ["m4a", "m4a"],
  ["webm", "webm"],
]

export const defaultFileName = (mimeType: string): string =>
  Arr.findFirst(EXTENSION_BY_MIME, ([pattern]) => mimeType.includes(pattern)).pipe(
    Option.match({
      onNone: () => "audio",
      onSome: ([, ext]) => `audio.${ext}`,
    }),
  )

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

export const httpStatusError: (status: number, body: string) => AiError.AiError = (status, body) =>
  Match.value(status).pipe(
    Match.when(
      429,
      (): AiError.AiError => new AiError.RateLimited({ provider: "elevenlabs", raw: body }),
    ),
    Match.whenOr(
      408,
      504,
      (): AiError.AiError => new AiError.Timeout({ provider: "elevenlabs", raw: body }),
    ),
    Match.when(
      401,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "elevenlabs", subtype: "auth", raw: body }),
    ),
    Match.when(
      403,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "elevenlabs", subtype: "permission", raw: body }),
    ),
    Match.when(
      402,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "elevenlabs", subtype: "billing", raw: body }),
    ),
    Match.when(
      413,
      (): AiError.AiError =>
        new AiError.ContextLengthExceeded({ provider: "elevenlabs", raw: body }),
    ),
    Match.when(
      (n) => n >= 500,
      (n): AiError.AiError =>
        new AiError.Unavailable({ provider: "elevenlabs", status: n, raw: body }),
    ),
    Match.orElse(
      (): AiError.AiError => new AiError.InvalidRequest({ provider: "elevenlabs", raw: body }),
    ),
  )

export const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "elevenlabs", raw: cause })
