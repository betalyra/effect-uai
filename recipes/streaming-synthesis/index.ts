/**
 * Pipe a Stream of text deltas through the generic
 * `SpeechSynthesizer.streamSynthesisFrom` capability. Provider-agnostic
 * at the call site — the runner picks the Layer and matching request shape.
 * Adding a provider is one `Match.when` here + one in the runner.
 */
import { Match } from "effect"
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

export type Provider = "elevenlabs" | "inworld"

/**
 * PCM s16le @ 48 kHz mono — matches the native rate of most browser
 * `AudioContext`s, so no resampling is needed in the worklet.
 */
const outputFormat = {
  container: "raw",
  encoding: "pcm_s16le",
  sampleRate: 48000,
  channels: 1,
} satisfies AudioFormat

/** Per-provider model + voice. */
export const providerConfig: (provider: Provider) => {
  readonly model: string
  readonly voiceId: string
} = Match.type<Provider>().pipe(
  Match.when("elevenlabs", () => ({
    model: "eleven_flash_v2_5",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
  })),
  Match.when("inworld", () => ({
    model: "inworld-tts-2",
    voiceId: "Sarah",
  })),
  Match.exhaustive,
)

export const synthesizeText = (provider: Provider) =>
  SpeechSynthesizer.streamSynthesisFrom({
    ...providerConfig(provider),
    outputFormat,
  })
