import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MockSpeechSynthesizer from "@effect-uai/core/testing/MockSpeechSynthesizer"
import { synthesizeOneShot, synthesizeStreaming } from "./index.js"

const fakeMp3 = (label: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (label + i) & 0xff)

describe("basic-speech-synthesis", () => {
  it("returns the scripted AudioBlob for one-shot synthesis", async () => {
    const mock = MockSpeechSynthesizer.layer({
      blobs: [
        {
          format: { container: "mp3", encoding: "mp3", sampleRate: 24000 },
          bytes: fakeMp3(0, 16),
          durationSeconds: 2,
        },
      ],
    })
    const result = await Effect.runPromise(synthesizeOneShot.pipe(Effect.provide(mock.layer)))
    expect(result.bytes.length).toBe(16)
    expect(result.format.container).toBe("mp3")
    expect(result.durationSeconds).toBe(2)
  })

  it("concatenates chunked stream output into a single Uint8Array", async () => {
    const chunks = [
      { bytes: fakeMp3(0, 4) },
      { bytes: fakeMp3(4, 4) },
      { bytes: fakeMp3(8, 4) },
    ]
    const mock = MockSpeechSynthesizer.layer({
      streamSynthesisChunks: [chunks],
    })
    const result = await Effect.runPromise(synthesizeStreaming.pipe(Effect.provide(mock.layer)))
    expect(result.chunkCount).toBe(3)
    expect(result.bytes.length).toBe(12)
    // Byte order must be preserved across chunk boundaries.
    expect(Array.from(result.bytes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
})
