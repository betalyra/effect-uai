import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MockSpeechSynthesizer from "@effect-uai/core/testing/MockSpeechSynthesizer"
import { synthesizeStreaming } from "./recipe.js"

const fakeBytes = (label: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (label + i) & 0xff)

describe("basic-speech-synthesis", () => {
  // The one piece of real logic here: chunks have to be joined in arrival
  // order, or the audio plays back scrambled.
  it("concatenates chunked stream output in order", async () => {
    const chunks = [
      { bytes: fakeBytes(0, 4) },
      { bytes: fakeBytes(4, 4) },
      { bytes: fakeBytes(8, 4) },
    ]
    const mock = MockSpeechSynthesizer.layer({ streamSynthesisChunks: [chunks] })

    const result = await Effect.runPromise(
      synthesizeStreaming("openai").pipe(Effect.provide(mock.layer)),
    )

    expect(result.chunkCount).toBe(3)
    expect(Array.from(result.bytes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
})
