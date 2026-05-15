import { Effect, Encoding, Match, Redacted, Result } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat } from "@effect-uai/core/Audio"
import type { InworldAudioEncoding } from "./models.js"

// ---------------------------------------------------------------------------
// Auth — `Authorization: Basic $INWORLD_API_KEY`. The portal key is already
// base64-encoded, so we inject it verbatim. Do NOT re-encode `key:secret`.
// ---------------------------------------------------------------------------

export const authHeader = (apiKey: Redacted.Redacted): string => `Basic ${Redacted.value(apiKey)}`

// ---------------------------------------------------------------------------
// AudioFormat → Inworld `audioConfig`
// ---------------------------------------------------------------------------

export type AudioConfig = {
  readonly audioEncoding: InworldAudioEncoding
  readonly sampleRateHertz?: number
  readonly bitRate?: number
  readonly speakingRate?: number
}

const unsupportedFormat = (format: AudioFormat): AiError.AiError =>
  new AiError.Unsupported({
    provider: "inworld",
    capability: "outputFormat",
    reason: `Cannot encode ${JSON.stringify(format)} as Inworld audioConfig. Supported: mp3, wav (LINEAR16), ogg+opus, flac, raw pcm_s16le/mulaw/alaw.`,
  })

/**
 * Map our cross-provider `AudioFormat` to Inworld's `audioConfig.audioEncoding`.
 *
 * Inworld quirk: sync `LINEAR16` / `WAV` responses include a WAV header in
 * the returned `audioContent`; streaming (NDJSON + WS) responses for the
 * same encoding do NOT include the header. Callers consuming raw PCM via
 * streaming should request `raw + pcm_s16le` (→ `PCM`) for predictable
 * concatenation, and reserve `wav` for sync.
 */
export const audioEncodingFor: (
  format: AudioFormat,
) => Effect.Effect<InworldAudioEncoding, AiError.AiError> = (format) =>
  Match.value(format).pipe(
    Match.when({ container: "mp3" }, () => Effect.succeed<InworldAudioEncoding>("MP3")),
    Match.when({ container: "wav" }, () => Effect.succeed<InworldAudioEncoding>("LINEAR16")),
    Match.when({ container: "ogg", encoding: "opus" }, () =>
      Effect.succeed<InworldAudioEncoding>("OGG_OPUS"),
    ),
    Match.when({ container: "flac" }, () => Effect.succeed<InworldAudioEncoding>("FLAC")),
    Match.when({ container: "raw", encoding: "pcm_s16le" }, () =>
      Effect.succeed<InworldAudioEncoding>("PCM"),
    ),
    Match.when({ container: "raw", encoding: "pcm_mulaw" }, () =>
      Effect.succeed<InworldAudioEncoding>("MULAW"),
    ),
    Match.when({ container: "raw", encoding: "pcm_alaw" }, () =>
      Effect.succeed<InworldAudioEncoding>("ALAW"),
    ),
    Match.orElse((f) => Effect.fail(unsupportedFormat(f))),
  )

export const audioConfigFor = (
  format: AudioFormat,
  speakingRate?: number,
): Effect.Effect<AudioConfig, AiError.AiError> =>
  Effect.map(audioEncodingFor(format), (audioEncoding) => ({
    audioEncoding,
    sampleRateHertz: format.sampleRate,
    ...(format.bitRate !== undefined && { bitRate: format.bitRate }),
    ...(speakingRate !== undefined && { speakingRate }),
  }))

/** Default Inworld output: 24 kHz mono mp3. Matches Inworld's docs default. */
export const defaultFormat: AudioFormat = {
  container: "mp3",
  encoding: "mp3",
  sampleRate: 24000,
}

// ---------------------------------------------------------------------------
// base64 → bytes — decoding `audioContent` from sync, NDJSON, and WS responses
// ---------------------------------------------------------------------------

export const decodeAudioContent = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(
        new AiError.GenerationFailed({
          provider: "inworld",
          raw: { message: "audioContent base64 decode failed", cause },
        }),
      ),
  })

// ---------------------------------------------------------------------------
// HTTP status → AiError
// ---------------------------------------------------------------------------

export const httpStatusError: (status: number, body: string) => AiError.AiError = (status, body) =>
  Match.value(status).pipe(
    Match.when(
      429,
      (): AiError.AiError => new AiError.RateLimited({ provider: "inworld", raw: body }),
    ),
    Match.whenOr(
      408,
      504,
      (): AiError.AiError => new AiError.Timeout({ provider: "inworld", raw: body }),
    ),
    Match.when(
      401,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "inworld", subtype: "auth", raw: body }),
    ),
    Match.when(
      403,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "inworld", subtype: "permission", raw: body }),
    ),
    Match.when(
      402,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "inworld", subtype: "billing", raw: body }),
    ),
    Match.when(
      413,
      (): AiError.AiError => new AiError.ContextLengthExceeded({ provider: "inworld", raw: body }),
    ),
    Match.when(
      (n) => n >= 500,
      (n): AiError.AiError =>
        new AiError.Unavailable({ provider: "inworld", status: n, raw: body }),
    ),
    Match.orElse(
      (): AiError.AiError => new AiError.InvalidRequest({ provider: "inworld", raw: body }),
    ),
  )

export const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "inworld", raw: cause })
