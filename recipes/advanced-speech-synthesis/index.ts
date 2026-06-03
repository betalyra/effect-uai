/**
 * Two TTS features that don't fit on `text + voiceId`:
 *
 * 1. **Multi-speaker dialogue** via `synthesizeDialogue` /
 *    `streamSynthesizeDialogue`. Turn array in, single `AudioBlob`
 *    (or `Stream<AudioChunk>`) out. Gated by the `MultiSpeakerTts`
 *    capability marker — only providers with native dialogue support
 *    register it, so calling against an unsupported provider is a
 *    compile-time error.
 *
 * 2. **Pronunciation without inline phonemes.** ElevenLabs has no
 *    stateless inline IPA path, so the Common `pronunciations` field
 *    fails `Unsupported` here. Instead, spell phonetically in the text:
 *    the hyphenated `to-MAY-to` / `to-MAH-to` variants below steer each
 *    voice's syllable stress with no phoneme API. For structured
 *    overrides, provision a pronunciation dictionary and pass
 *    `pronunciationDictionaryLocators` on the ElevenLabs-typed request.
 *
 * The example compares American and British English pronunciations of
 * the same base words: a different hyphenated spelling per voice.
 */
import { Array as Arr, Effect, Stream } from "effect"
import type { AudioChunk } from "@effect-uai/core/Audio"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

// ElevenLabs voice IDs are workspace-bound. These two are commonly
// provisioned premade voices; swap for voices you own if your workspace
// doesn't include them (you'll see `voice_not_found` on first request).
const VOICE_AMERICAN = "JBFqnCBsd6RMkjVDRZzb" // "George"
const VOICE_BRITISH = "EXAVITQu4vr4xnSDxMaL" // "Sarah"

/**
 * Hyphenated spelling variants, one per turn, that steer each voice's
 * pronunciation in the text itself, no phoneme API required (ElevenLabs
 * has no stateless inline IPA path).
 */
export const spellingVariants: ReadonlyArray<string> = [
  "to-MAY-to",
  "to-MAH-to",
  "po-TAY-to",
  "po-TAH-to",
]

export const dialogueTurns: ReadonlyArray<SpeechSynthesizer.DialogueTurn> = [
  { voiceId: VOICE_AMERICAN, text: "In American English, it's to-MAY-to." },
  { voiceId: VOICE_BRITISH, text: "In British English, it's to-MAH-to." },
  { voiceId: VOICE_AMERICAN, text: "And we say po-TAY-to." },
  { voiceId: VOICE_BRITISH, text: "Whereas we say po-TAH-to." },
  { voiceId: VOICE_AMERICAN, text: "Same spelling, different worlds." },
]

const mp3: SpeechSynthesizer.CommonSynthesizeRequest["outputFormat"] = {
  container: "mp3",
  encoding: "mp3",
  sampleRate: 44100,
  bitRate: 128,
}

const request: SpeechSynthesizer.CommonSynthesizeDialogueRequest = {
  model: "eleven_v3",
  turns: dialogueTurns,
  outputFormat: mp3,
}

/**
 * One-shot dialogue. Requires `SpeechSynthesizer` and the
 * `MultiSpeakerTts` capability marker in `R`.
 */
export const synthesizeDialogueOneShot = () => SpeechSynthesizer.synthesizeDialogue(request)

const concatChunks = (chunks: ReadonlyArray<AudioChunk>): Uint8Array =>
  Uint8Array.from(Arr.flatMap(chunks, (c) => Arr.fromIterable(c.bytes)))

/** Streamed dialogue. Audio chunks arrive as the wire delivers them. */
export const synthesizeDialogueStreaming = () =>
  SpeechSynthesizer.streamSynthesizeDialogue(request).pipe(
    Stream.runCollect,
    Effect.map((chunks) => ({ chunkCount: chunks.length, bytes: concatChunks(chunks) })),
  )
