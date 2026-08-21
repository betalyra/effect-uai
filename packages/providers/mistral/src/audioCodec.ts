import { Array as Arr, Effect, Encoding, Match, Option, Result } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioFormat, AudioSource } from "@effect-uai/core/Audio"

// ---------------------------------------------------------------------------
// AudioSource → Blob (for multipart upload to /audio/transcriptions)
// ---------------------------------------------------------------------------

const decodeBase64ToBytes = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(new AiError.InvalidRequest({ provider: "mistral", param: "audio", raw: cause })),
  })

/**
 * TS 6's `Blob` constructor wants `Uint8Array<ArrayBuffer>`; our domain carries
 * the broader `Uint8Array<ArrayBufferLike>`. The cast is sound: `Blob()` does
 * not mutate the buffer and the runtime accepts both.
 */
const bytesToBlob = (bytes: Uint8Array, mimeType: string): Blob =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType })

/**
 * Build a `Blob` from any `AudioSource` variant. `url` variants pass through
 * to the `file_url` field upstream, so this only handles inline bytes/base64.
 */
export const audioToBlob: (audio: AudioSource) => Effect.Effect<Blob, AiError.AiError> =
  Match.type<AudioSource>().pipe(
    Match.tag("bytes", (a) => Effect.succeed(bytesToBlob(a.bytes, a.mimeType))),
    Match.tag("base64", (a) =>
      decodeBase64ToBytes(a.base64).pipe(Effect.map((bytes) => bytesToBlob(bytes, a.mimeType))),
    ),
    Match.tag("url", (a) =>
      Effect.fail(
        new AiError.InvalidRequest({
          provider: "mistral",
          param: "audio",
          raw: `Pass URL audio via the request's url source; got ${a.url} where inline bytes were expected.`,
        }),
      ),
    ),
    Match.exhaustive,
  )

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

/** Derive a default upload filename from a MIME type, e.g. `audio/mpeg` -> `audio.mp3`. */
export const defaultFileName = (mimeType: string): string =>
  Arr.findFirst(EXTENSION_BY_MIME, ([pattern]) => mimeType.includes(pattern)).pipe(
    Option.match({ onNone: () => "audio", onSome: ([, ext]) => `audio.${ext}` }),
  )

// ---------------------------------------------------------------------------
// AudioFormat → Voxtral TTS `response_format`
// ---------------------------------------------------------------------------

export type MistralTtsFormat = "mp3" | "wav" | "pcm" | "flac" | "opus"

/**
 * Map an `AudioFormat.container` to Voxtral TTS's `response_format`. Voxtral
 * produces mp3 / wav / pcm / flac / opus; aac / ogg / webm are unsupported.
 */
export const containerToTtsFormat: (
  container: AudioFormat["container"],
) => Effect.Effect<MistralTtsFormat, AiError.AiError> = Match.type<AudioFormat["container"]>().pipe(
  Match.when("mp3", () => Effect.succeed<MistralTtsFormat>("mp3")),
  Match.when("wav", () => Effect.succeed<MistralTtsFormat>("wav")),
  Match.when("raw", () => Effect.succeed<MistralTtsFormat>("pcm")),
  Match.when("flac", () => Effect.succeed<MistralTtsFormat>("flac")),
  Match.when("opus", () => Effect.succeed<MistralTtsFormat>("opus")),
  Match.whenOr("aac", "ogg", "webm", (c) =>
    Effect.fail(
      new AiError.Unsupported({
        provider: "mistral",
        capability: "outputFormat",
        reason: `Voxtral TTS does not produce ${c} output; supported: mp3 | wav | pcm (raw) | flac | opus.`,
      }),
    ),
  ),
  Match.exhaustive,
)

/**
 * The on-wire `AudioFormat` Voxtral actually returns for each
 * `response_format`. Voxtral's `pcm` is float32 LE at 24 kHz; the caller's
 * requested sample rate is not honoured for raw output.
 */
export const realizedTtsFormat: (rf: MistralTtsFormat) => AudioFormat =
  Match.type<MistralTtsFormat>().pipe(
    Match.when("mp3", (): AudioFormat => ({
      container: "mp3",
      encoding: "mp3",
      sampleRate: 24000,
    })),
    Match.when("wav", (): AudioFormat => ({
      container: "wav",
      encoding: "pcm_s16le",
      sampleRate: 24000,
    })),
    Match.when("pcm", (): AudioFormat => ({
      container: "raw",
      encoding: "pcm_f32le",
      sampleRate: 24000,
    })),
    Match.when("flac", (): AudioFormat => ({
      container: "flac",
      encoding: "flac",
      sampleRate: 24000,
    })),
    Match.when("opus", (): AudioFormat => ({
      container: "opus",
      encoding: "opus",
      sampleRate: 24000,
    })),
    Match.exhaustive,
  )
