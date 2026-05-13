/**
 * Pipe a Stream of text deltas through the generic
 * `SpeechSynthesizer.streamSynthesisFrom` capability. The recipe stays
 * provider-agnostic — currently only `elevenlabs` provides the
 * `TtsIncrementalText` marker, but new providers slot in via the same
 * Match-based dispatch we use in basic-speech-synthesis.
 */
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

export type Provider = "elevenlabs"

/**
 * PCM s16le @ 48 kHz mono — matches the native rate of most browser
 * `AudioContext`s, so no resampling is needed in the worklet.
 */
const outputFormat = {
  container: "raw",
  encoding: "pcm_s16le",
  sampleRate: 48000,
  channels: 1,
} as const

export const synthesizeText = SpeechSynthesizer.streamSynthesisFrom({
  model: "eleven_flash_v2_5",
  voiceId: "JBFqnCBsd6RMkjVDRZzb",
  outputFormat,
})
