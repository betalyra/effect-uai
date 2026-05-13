/**
 * Streaming transcription helper: takes a Stream of audio frames (raw
 * PCM s16le @ 16 kHz mono) and returns a Stream of `TranscriptEvent`s
 * via the generic `Transcriber.streamTranscriptionFrom` capability.
 *
 * Provider-agnostic at the call site — the runner picks the Layer.
 * Currently only `elevenlabs` provides the `SttStreaming` marker; new
 * providers will slot into the `Provider` union (the recipe currently
 * has just the one case; the union is here so adding e.g. Cloud Speech
 * later is a one-line Match.when in the runner).
 */
import * as Transcriber from "@effect-uai/core/Transcriber"

export type Provider = "elevenlabs"

/** PCM s16le @ 16 kHz mono — what the browser AudioWorklet posts. */
const inputFormat = {
  container: "raw",
  encoding: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
} as const

export const transcribeMicStream = Transcriber.streamTranscriptionFrom({
  model: "scribe_v2_realtime",
  inputFormat,
  wordTimestamps: true,
})
