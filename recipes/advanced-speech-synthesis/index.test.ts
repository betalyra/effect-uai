import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { AudioBlob, AudioChunk } from "@effect-uai/core/Audio"
import * as MockSpeechSynthesizer from "@effect-uai/core/testing/MockSpeechSynthesizer"
import {
  dialogueTurns,
  pronunciations,
  synthesizeDialogueOneShot,
  synthesizeDialogueStreaming,
} from "./index.js"

const fakeBytes = (label: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (label + i) & 0xff)

const mp3Blob = (label: number, length: number): AudioBlob => ({
  format: { container: "mp3", encoding: "mp3", sampleRate: 44100, bitRate: 128 },
  bytes: fakeBytes(label, length),
})

describe("advanced-speech-synthesis", () => {
  it("sends every turn + pronunciations on synthesizeDialogue", async () => {
    const mock = MockSpeechSynthesizer.layer({ dialogueBlobs: [mp3Blob(0, 8)] })
    const program = Effect.gen(function* () {
      const blob = yield* synthesizeDialogueOneShot()
      return { blob, rec: yield* mock.recorder }
    })
    const { blob, rec } = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(blob.bytes.length).toBe(8)
    expect(rec.synthesizeDialogueCalls.length).toBe(1)
    const call = rec.synthesizeDialogueCalls[0]!
    expect(call.model).toBe("eleven_v3")
    expect(call.turns).toEqual(dialogueTurns)
    expect(call.pronunciations).toEqual(pronunciations)
  })

  it("keys each pronunciation on a per-turn spelling variant", () => {
    // Each turn's text contains exactly one of the four spelling variants
    // (except the closer), so the per-spelling map produces per-voice
    // accents rather than one uniform pronunciation.
    const phrases = pronunciations.map((p) => p.phrase)
    expect(phrases).toEqual(["to-MAY-to", "to-MAH-to", "po-TAY-to", "po-TAH-to"])
    for (const phrase of phrases) {
      const occurrences = dialogueTurns.filter((t) => t.text.includes(phrase))
      expect(occurrences.length).toBe(1)
    }
  })

  it("concatenates chunks for streamSynthesizeDialogue", async () => {
    const chunks: ReadonlyArray<AudioChunk> = [
      { bytes: fakeBytes(0, 4) },
      { bytes: fakeBytes(4, 4) },
      { bytes: fakeBytes(8, 4) },
    ]
    const mock = MockSpeechSynthesizer.layer({ streamSynthesizeDialogueChunks: [chunks] })
    const result = await Effect.runPromise(
      synthesizeDialogueStreaming().pipe(Effect.provide(mock.layer)),
    )
    expect(result.chunkCount).toBe(3)
    expect(Array.from(result.bytes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
})
