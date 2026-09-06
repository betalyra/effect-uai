/**
 * Synthesize a short phrase via the generic `SpeechSynthesizer` service.
 * Model, voice and output format travel together per provider, so they are
 * keyed off a `Provider` union here and `app.ts` picks the Layer from the
 * same name.
 *
 * Adding a provider means a case in `requestFor` and one in `outputExtFor`;
 * `Match.exhaustive` fails typecheck until both are there.
 */
import { Array, Effect, Match, Stream } from "effect"
import type { AudioChunk } from "@effect-uai/core/Audio"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

export type Provider = "openai" | "google" | "elevenlabs" | "inworld"

const phrase = "Hello from effect-uai. This is a short test of speech synthesis."

const requestFor = Match.type<Provider>().pipe(
  Match.when("openai", () => ({
    text: phrase,
    model: "gpt-4o-mini-tts",
    voiceId: "alloy",
    outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 24000 } as const,
  })),
  Match.when("google", () => ({
    text: phrase,
    model: "gemini-2.5-flash-preview-tts",
    voiceId: "Kore",
    outputFormat: {
      container: "wav",
      encoding: "pcm_s16le",
      sampleRate: 24000,
      channels: 1,
    } as const,
  })),
  Match.when("elevenlabs", () => ({
    text: phrase,
    model: "eleven_multilingual_v2",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    outputFormat: {
      container: "mp3",
      encoding: "mp3",
      sampleRate: 44100,
      bitRate: 128,
    } as const,
  })),
  Match.when("inworld", () => ({
    text: phrase,
    model: "inworld-tts-2",
    voiceId: "Sarah",
    outputFormat: {
      container: "mp3",
      encoding: "mp3",
      sampleRate: 24000,
    } as const,
  })),
  Match.exhaustive,
)

/** File extension that matches each provider's native output container. */
export const outputExtFor = Match.type<Provider>().pipe(
  Match.when("openai", () => "mp3"),
  Match.when("google", () => "wav"),
  Match.when("elevenlabs", () => "mp3"),
  Match.when("inworld", () => "mp3"),
  Match.exhaustive,
)

const concatChunks = (chunks: ReadonlyArray<AudioChunk>) =>
  Uint8Array.from(Array.flatMap(chunks, (c) => Array.fromIterable(c.bytes)))

/** The model each provider's preset uses, so `app.ts` can name it in a log line. */
export const modelFor = (provider: Provider): string => requestFor(provider).model

/** One-shot synthesis: full audio as a single `AudioBlob`. */
export const synthesizeOneShot = (provider: Provider) =>
  SpeechSynthesizer.synthesize(requestFor(provider))

/** Chunked synthesis: audio arrives as a `Stream<AudioChunk>`; collected here for demo. */
export const synthesizeStreaming = (provider: Provider) =>
  Stream.runCollect(SpeechSynthesizer.streamSynthesis(requestFor(provider))).pipe(
    Effect.map((chunks) => ({ chunkCount: chunks.length, bytes: concatChunks(chunks) })),
  )
