/**
 * Transcribe an audio file with OpenAI's speech-to-text models. The
 * file is supplied as an `AudioSource` so this recipe is independent of
 * the filesystem (`run-node.ts` reads bytes off disk; in a browser the
 * same `transcribeAudio` works with a `Uint8Array` from a `File`).
 *
 * Two variants:
 * - `transcribeGpt4o` — `gpt-4o-transcribe` (fast, no per-word timestamps).
 * - `transcribeWhisperVerbose` — `whisper-1` with `wordTimestamps: true`
 *   to also return per-word `WordTimestamp[]`.
 *
 * `index.ts` exports the building blocks; the runner lives in `run-node.ts`.
 */
import type { Effect } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import type { AudioSource } from "@effect-uai/core/Audio"
import type { TranscriptResult } from "@effect-uai/core/Transcript"
import * as Transcriber from "@effect-uai/core/Transcriber"

/** Sync transcription with `gpt-4o-transcribe` — text-only, fast. */
export const transcribeGpt4o = (
  audio: AudioSource,
): Effect.Effect<TranscriptResult, AiError.AiError, Transcriber.Transcriber> =>
  Transcriber.transcribe({
    audio,
    model: "gpt-4o-transcribe",
  })

/** Sync transcription with `whisper-1` + per-word timestamps. */
export const transcribeWhisperVerbose = (
  audio: AudioSource,
): Effect.Effect<TranscriptResult, AiError.AiError, Transcriber.Transcriber> =>
  Transcriber.transcribe({
    audio,
    model: "whisper-1",
    wordTimestamps: true,
  })
