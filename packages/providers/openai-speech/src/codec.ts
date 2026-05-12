import { Array, Effect, Encoding, Match, Option, Result } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat, AudioSource } from "@effect-uai/core/Audio"

// ---------------------------------------------------------------------------
// AudioSource → Blob (for multipart upload)
// ---------------------------------------------------------------------------

const decodeBase64ToBytes = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(new AiError.InvalidRequest({ provider: "openai", param: "audio", raw: cause })),
  })

const urlNotSupported: AiError.AiError = new AiError.InvalidRequest({
  provider: "openai",
  param: "audio",
  raw: 'OpenAI does not accept URL audio for /v1/audio/transcriptions. Fetch the URL yourself and pass `{ _tag: "bytes", bytes, mimeType }`.',
})

/**
 * Build a `Blob` from any `AudioSource` variant. URL variants are
 * rejected with `InvalidRequest` — OpenAI requires inline upload.
 */
/**
 * Build a Blob from a Uint8Array. TS 6's `Blob` constructor wants
 * `Uint8Array<ArrayBuffer>` (narrow generic param), but our domain
 * carries `Uint8Array<ArrayBufferLike>` (broader). The cast is sound
 * — `Blob()` doesn't mutate the buffer and the runtime accepts both.
 */
const bytesToBlob = (bytes: Uint8Array, mimeType: string): Blob =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType })

export const audioToBlob: (audio: AudioSource) => Effect.Effect<Blob, AiError.AiError> =
  Match.type<AudioSource>().pipe(
    Match.tag("bytes", (a) => Effect.succeed(bytesToBlob(a.bytes, a.mimeType))),
    Match.tag("base64", (a) =>
      decodeBase64ToBytes(a.base64).pipe(
        Effect.map((bytes) => bytesToBlob(bytes, a.mimeType)),
      ),
    ),
    Match.tag("url", () => Effect.fail(urlNotSupported)),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// MIME → file extension (OpenAI uses the extension to detect format)
// ---------------------------------------------------------------------------

/**
 * MIME-substring → file extension. OpenAI's multipart upload uses the
 * `filename` field extension to detect the audio format — Content-Type
 * alone is unreliable. Ordering is significant only inasmuch as
 * `findFirst` returns the first match.
 */
const EXTENSION_BY_MIME: ReadonlyArray<readonly [pattern: string, ext: string]> = [
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

/**
 * Derive a default filename from a MIME type, e.g. `"audio/mpeg"` →
 * `"audio.mp3"`. Falls back to `"audio"` (no extension) when the MIME
 * isn't recognized. Callers can override via the request's `fileName`
 * field.
 */
export const defaultFileName = (mimeType: string): string =>
  Array.findFirst(EXTENSION_BY_MIME, ([pattern]) => mimeType.includes(pattern)).pipe(
    Option.match({
      onNone: () => "audio",
      onSome: ([, ext]) => `audio.${ext}`,
    }),
  )

// ---------------------------------------------------------------------------
// AudioFormat → OpenAI `response_format` (TTS)
// ---------------------------------------------------------------------------

export type OpenAIResponseFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm"

/**
 * Map an `AudioFormat.container` to OpenAI TTS's `response_format` enum.
 * `ogg` and `webm` are unsupported by OpenAI TTS.
 *
 * Note: OpenAI's `pcm` is fixed at 24 kHz, signed 16-bit, mono. The
 * caller's `sampleRate` is ignored — we report the realized format in
 * the returned `AudioBlob.format`.
 */
export const containerToResponseFormat: (
  container: AudioFormat["container"],
) => Effect.Effect<OpenAIResponseFormat, AiError.AiError> = Match.type<
  AudioFormat["container"]
>().pipe(
  Match.whenOr("mp3", "opus", "aac", "flac", "wav", (c) => Effect.succeed(c as OpenAIResponseFormat)),
  Match.when("raw", () => Effect.succeed<OpenAIResponseFormat>("pcm")),
  Match.whenOr("ogg", "webm", (c) =>
    Effect.fail(
      new AiError.Unsupported({
        provider: "openai",
        capability: "outputFormat",
        reason: `OpenAI TTS does not produce ${c} output; supported: mp3 | opus | aac | flac | wav | pcm (raw).`,
      }),
    ),
  ),
  Match.exhaustive,
)

/**
 * Pure inverse: report the on-wire `AudioFormat` that OpenAI actually
 * returns for each `response_format`. Used to populate
 * `AudioBlob.format` on the response.
 */
export const realizedFormat: (rf: OpenAIResponseFormat) => AudioFormat =
  Match.type<OpenAIResponseFormat>().pipe(
    Match.when("mp3", (): AudioFormat => ({ container: "mp3", encoding: "mp3", sampleRate: 24000 })),
    Match.when(
      "opus",
      (): AudioFormat => ({ container: "opus", encoding: "opus", sampleRate: 24000 }),
    ),
    Match.when(
      "aac",
      (): AudioFormat => ({ container: "aac", encoding: "aac", sampleRate: 24000 }),
    ),
    Match.when(
      "flac",
      (): AudioFormat => ({ container: "flac", encoding: "flac", sampleRate: 24000 }),
    ),
    Match.when(
      "wav",
      (): AudioFormat => ({ container: "wav", encoding: "pcm_s16le", sampleRate: 24000 }),
    ),
    Match.when(
      "pcm",
      (): AudioFormat => ({ container: "raw", encoding: "pcm_s16le", sampleRate: 24000 }),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

/**
 * Map an HTTP status code from an OpenAI endpoint to the appropriate
 * `AiError` variant. Shared by both transcriber and synthesizer.
 */
export const httpStatusError: (status: number, body: string) => AiError.AiError = (status, body) =>
  Match.value(status).pipe(
    Match.when(429, (): AiError.AiError => new AiError.RateLimited({ provider: "openai", raw: body })),
    Match.whenOr(
      408,
      504,
      (): AiError.AiError => new AiError.Timeout({ provider: "openai", raw: body }),
    ),
    Match.when(
      401,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "openai", subtype: "auth", raw: body }),
    ),
    Match.when(
      403,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "openai", subtype: "permission", raw: body }),
    ),
    Match.when(
      402,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "openai", subtype: "billing", raw: body }),
    ),
    Match.when(
      413,
      (): AiError.AiError => new AiError.ContextLengthExceeded({ provider: "openai", raw: body }),
    ),
    Match.when(
      (n) => n >= 500,
      (n): AiError.AiError => new AiError.Unavailable({ provider: "openai", status: n, raw: body }),
    ),
    Match.orElse((): AiError.AiError => new AiError.InvalidRequest({ provider: "openai", raw: body })),
  )

export const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "openai", raw: cause })
