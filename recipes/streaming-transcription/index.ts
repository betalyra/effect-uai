/**
 * Streaming transcription helper: takes a `Stream<Uint8Array>` of mic
 * frames (raw PCM s16le, provider-specific sample rate, mono) and
 * returns a `Stream<TranscriptEvent>` via the generic
 * `Transcriber.streamTranscriptionFrom` capability.
 *
 * The recipe stays provider-agnostic — the runner picks the Layer.
 * Adding a provider is one `Match.when` here + one in `layerFor`.
 */
import { Match } from "effect"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as Transcriber from "@effect-uai/core/Transcriber"

export type Provider = "elevenlabs" | "openai"

export const providerConfig: (provider: Provider) => {
  readonly model: string
  readonly inputFormat: AudioFormat
} = Match.type<Provider>().pipe(
  Match.when("elevenlabs", () => ({
    model: "scribe_v2_realtime",
    inputFormat: {
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    } satisfies AudioFormat,
  })),
  Match.when("openai", () => ({
    model: "gpt-4o-mini-transcribe",
    inputFormat: {
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 24000,
      channels: 1,
    } satisfies AudioFormat,
  })),
  Match.exhaustive,
)

export const transcribeMicStream = (provider: Provider) =>
  Transcriber.streamTranscriptionFrom({
    ...providerConfig(provider),
    wordTimestamps: true,
  })
