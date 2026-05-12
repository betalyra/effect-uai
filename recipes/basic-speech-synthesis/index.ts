/**
 * Synthesize a short phrase with OpenAI TTS, both as a one-shot `synthesize`
 * (full audio bytes returned in one go) and as a chunked `streamSynthesis`
 * (audio arrives as a Stream of chunks).
 *
 * `index.ts` exports the building blocks; the runner lives in `run.ts`.
 */
import { Array, Effect, Stream } from "effect"
import type { AudioChunk } from "@effect-uai/core/Audio"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

const phrase = "Hello from effect-uai. This is a short test of speech synthesis."

/** One-shot synthesis: returns the full audio as a single `AudioBlob`. */
export const synthesizeOneShot = SpeechSynthesizer.synthesize({
  text: phrase,
  model: "gpt-4o-mini-tts",
  voiceId: "alloy",
  outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 24000 },
})

/**
 * Concatenate a sequence of `AudioChunk`s into one `Uint8Array`. Functional:
 * `Array.flatMap` flattens each chunk's bytes into one logical stream of
 * numbers, then `Uint8Array.from` builds the result in a single allocation.
 */
const concatChunks = (chunks: ReadonlyArray<AudioChunk>): Uint8Array =>
  Uint8Array.from(Array.flatMap(chunks, (c) => Array.fromIterable(c.bytes)))

/**
 * Chunked synthesis: audio arrives as a Stream of chunks. Collect and
 * concat to get the full audio, or pipe the stream directly to a speaker
 * / WebSocket without buffering.
 */
export const synthesizeStreaming = Stream.runCollect(
  SpeechSynthesizer.streamSynthesis({
    text: phrase,
    model: "gpt-4o-mini-tts",
    voiceId: "alloy",
    outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 24000 },
  }),
).pipe(
  Effect.map((chunks) => ({
    chunkCount: chunks.length,
    bytes: concatChunks(chunks),
  })),
)
