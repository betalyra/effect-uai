import { Effect, Encoding, Match, Result } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioSource } from "@effect-uai/core/Audio"

/**
 * Shared codec helpers for Gemini speech endpoints. The TTS and STT
 * variants both ride on `:generateContent`, so the audio-in / audio-out
 * shapes are siblings.
 */

const urlNotSupported: AiError.AiError = new AiError.InvalidRequest({
  provider: "gemini",
  param: "audio",
  raw: 'Gemini inline audio does not accept URL sources. Either fetch the URL yourself and pass `{ _tag: "bytes", bytes, mimeType }`, or upload via the Files API and pass a `fileData` URI (not yet wired here).',
})

/** Wire shape for an inline-audio part on `generateContent`. */
export type InlineAudioData = {
  readonly mimeType: string
  readonly data: string
}

/**
 * Encode any `AudioSource` into the `inlineData` shape expected by
 * Gemini's `generateContent`. URL variants are rejected with
 * `InvalidRequest` — Files API upload is a separate flow.
 *
 * Caller is responsible for keeping the total request body under
 * 20 MB. Beyond that, Gemini's Files API is the only path.
 */
export const audioSourceToInlineData: (
  audio: AudioSource,
) => Effect.Effect<InlineAudioData, AiError.AiError> = Match.type<AudioSource>().pipe(
  Match.tag("bytes", (a) =>
    Effect.succeed<InlineAudioData>({
      mimeType: a.mimeType,
      data: Encoding.encodeBase64(a.bytes),
    }),
  ),
  Match.tag("base64", (a) =>
    Effect.succeed<InlineAudioData>({ mimeType: a.mimeType, data: a.base64 }),
  ),
  Match.tag("url", () => Effect.fail(urlNotSupported)),
  Match.exhaustive,
)

/** Decode a base64-encoded audio payload into bytes. */
export const decodeBase64Audio = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(new AiError.InvalidRequest({ provider: "gemini", param: "audio", raw: cause })),
  })

/**
 * Wrap a raw 16-bit signed little-endian PCM buffer in a standard 44-byte
 * RIFF/WAVE header. Gemini TTS returns PCM-only — for playback or for
 * round-tripping into Gemini transcription (which accepts wav, not raw
 * PCM), the bytes need a container.
 */
export const wrapPcmAsWav = (
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
  bitsPerSample = 16,
): Uint8Array => {
  const dataSize = pcm.length
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const totalSize = 44 + dataSize
  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeAscii(0, "RIFF")
  view.setUint32(4, totalSize - 8, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(36, "data")
  view.setUint32(40, dataSize, true)
  new Uint8Array(buffer, 44, dataSize).set(pcm)
  return new Uint8Array(buffer)
}

/**
 * HTTP status → typed `AiError`. Shared between synthesizer and
 * transcriber.
 */
export const httpStatusError: (status: number, body: string) => AiError.AiError = (status, body) =>
  Match.value(status).pipe(
    Match.when(
      429,
      (): AiError.AiError => new AiError.RateLimited({ provider: "gemini", raw: body }),
    ),
    Match.whenOr(
      408,
      504,
      (): AiError.AiError => new AiError.Timeout({ provider: "gemini", raw: body }),
    ),
    Match.when(
      401,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "gemini", subtype: "auth", raw: body }),
    ),
    Match.when(
      403,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "gemini", subtype: "permission", raw: body }),
    ),
    Match.when(
      402,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "gemini", subtype: "billing", raw: body }),
    ),
    Match.when(
      413,
      (): AiError.AiError => new AiError.ContextLengthExceeded({ provider: "gemini", raw: body }),
    ),
    Match.when(
      (n) => n >= 500,
      (n): AiError.AiError => new AiError.Unavailable({ provider: "gemini", status: n, raw: body }),
    ),
    Match.orElse(
      (): AiError.AiError => new AiError.InvalidRequest({ provider: "gemini", raw: body }),
    ),
  )

export const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "gemini", raw: cause })
