import { Duration, Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MockSpeechSynthesizer from "@effect-uai/core/testing/MockSpeechSynthesizer"
import { synthesizeOneShot, synthesizeStreaming, type Provider } from "./index.js"

const fakeBytes = (label: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (label + i) & 0xff)

const providers: ReadonlyArray<Provider> = ["openai", "gemini"]

describe.each(providers)("basic-speech-synthesis (%s)", (provider) => {
  it("returns the scripted AudioBlob for one-shot synthesis", async () => {
    const mock = MockSpeechSynthesizer.layer({
      blobs: [
        {
          format: { container: "raw", encoding: "pcm_s16le", sampleRate: 24000 },
          bytes: fakeBytes(0, 16),
          duration: Duration.seconds(2),
        },
      ],
    })
    const result = await Effect.runPromise(
      synthesizeOneShot(provider).pipe(Effect.provide(mock.layer)),
    )
    expect(result.bytes.length).toBe(16)
    expect(result.duration).toEqual(Duration.seconds(2))
  })

  it("concatenates chunked stream output into a single Uint8Array", async () => {
    const chunks = [
      { bytes: fakeBytes(0, 4) },
      { bytes: fakeBytes(4, 4) },
      { bytes: fakeBytes(8, 4) },
    ]
    const mock = MockSpeechSynthesizer.layer({ streamSynthesisChunks: [chunks] })
    const result = await Effect.runPromise(
      synthesizeStreaming(provider).pipe(Effect.provide(mock.layer)),
    )
    expect(result.chunkCount).toBe(3)
    expect(Array.from(result.bytes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
})

describe("basic-speech-synthesis provider dispatch", () => {
  it("sends each provider's expected model + voice on the request", async () => {
    const mock = MockSpeechSynthesizer.layer({
      blobs: [
        {
          format: { container: "mp3", encoding: "mp3", sampleRate: 24000 },
          bytes: new Uint8Array(),
        },
        {
          format: { container: "wav", encoding: "pcm_s16le", sampleRate: 24000 },
          bytes: new Uint8Array(),
        },
      ],
    })
    const program = Effect.gen(function* () {
      yield* synthesizeOneShot("openai")
      yield* synthesizeOneShot("gemini")
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.synthesizeCalls[0]).toMatchObject({
      model: "gpt-4o-mini-tts",
      voiceId: "alloy",
    })
    expect(rec.synthesizeCalls[1]).toMatchObject({
      model: "gemini-2.5-flash-preview-tts",
      voiceId: "Kore",
    })
  })
})
