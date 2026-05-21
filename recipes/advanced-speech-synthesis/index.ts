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
 * 2. **Custom pronunciations** via the optional `pronunciations` field
 *    on `CommonSynthesizeDialogueRequest`. Adapters that can't honor
 *    an entry silently drop it; audio still renders with the default
 *    pronunciation.
 *
 * The example below compares American and British English
 * pronunciations of two words — same spelling, different sound per
 * voice. The trick is that the `pronunciations` map keys on each
 * turn's hyphenated spelling variant (`to-MAY-to` vs `to-MAH-to`), so
 * each voice picks up the matching IPA hint. The hyphenated spellings
 * also guide engines that silently drop the phoneme tags (i.e.
 * ElevenLabs `eleven_v3`) toward the right syllable pattern.
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
 * Per-spelling IPA hints. Each turn uses a different hyphenated
 * spelling so the pronunciations map keys on what that voice
 * actually says, not on a shared base form like `"tomato"`.
 */
export const pronunciations: ReadonlyArray<SpeechSynthesizer.CustomPronunciation> = [
  { phrase: "to-MAY-to", pronunciation: "təˈmeɪtoʊ", encoding: "ipa" },
  { phrase: "to-MAH-to", pronunciation: "təˈmɑːtoʊ", encoding: "ipa" },
  { phrase: "po-TAY-to", pronunciation: "pəˈteɪtoʊ", encoding: "ipa" },
  { phrase: "po-TAH-to", pronunciation: "pəˈtɑːtoʊ", encoding: "ipa" },
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
  pronunciations,
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
