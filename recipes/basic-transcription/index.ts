/**
 * Transcribe an audio file via the generic `Transcriber` service. The
 * audio is supplied as an `AudioSource` so this recipe is independent
 * of the filesystem (`run-node.ts` reads bytes off disk; in a browser
 * the same calls work with a `Uint8Array` from a `File`).
 *
 * Provider-specific request shape is keyed off a `Provider` tagged
 * union so `run-node.ts` can pick the Layer based on a `--provider`
 * CLI flag.
 *
 * Two variants:
 *
 * - `transcribeFast(provider, audio)` — each provider's fast text-only
 *   model. Universally available.
 * - `transcribeVerbose(audio)` — `whisper-1` with `wordTimestamps:
 *   true`. **OpenAI only** — not every provider surfaces structured
 *   per-word timing, so this is intentionally not provider-switchable.
 *
 * Add a new provider in two places:
 *   1. extend the `Provider` union below
 *   2. add a `Match.when` case in `fastModelFor` and in `run-node.ts`'
 *      `layerFor`.
 */
import { Match } from "effect"
import type { AudioSource } from "@effect-uai/core/Audio"
import * as Transcriber from "@effect-uai/core/Transcriber"

export type Provider = "openai" | "elevenlabs" | "inworld"

const fastModelFor = Match.type<Provider>().pipe(
  Match.when("openai", () => "gpt-4o-transcribe"),
  Match.when("elevenlabs", () => "scribe_v2"),
  Match.when("inworld", () => "inworld/inworld-stt-1"),
  Match.exhaustive,
)

/** Sync transcription using each provider's fast text-only model. */
export const transcribeFast = (provider: Provider, audio: AudioSource) =>
  Transcriber.transcribe({ audio, model: fastModelFor(provider) })

/**
 * OpenAI-only: `whisper-1` with per-word timestamps. Pointing a
 * provider without structured per-word timing at this would not return
 * a `words` array.
 */
export const transcribeVerbose = (audio: AudioSource) =>
  Transcriber.transcribe({ audio, model: "whisper-1", wordTimestamps: true })
