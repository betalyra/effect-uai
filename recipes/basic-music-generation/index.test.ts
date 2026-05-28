import { Duration, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { singleVariant } from "@effect-uai/core/Music"
import * as MockMusicGenerator from "@effect-uai/core/testing/MockMusicGenerator"
import { defaultModel, run, runDefault } from "./index.js"

const fakeBytes = (label: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (label + i) & 0xff)

describe("basic-music-generation", () => {
  it("returns the scripted GenerateResult against a mock", async () => {
    const mock = MockMusicGenerator.layer({
      results: [
        singleVariant({
          audio: {
            format: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
            bytes: fakeBytes(0, 32),
            duration: Duration.seconds(30),
          },
          provider: "lyria",
          watermark: "synthid",
        }),
      ],
    })
    const result = await Effect.runPromise(runDefault("google").pipe(Effect.provide(mock.layer)))
    expect(result.primary.audio.bytes.length).toBe(32)
    expect(result.primary.audio.format.container).toBe("mp3")
    expect(result.primary.watermark).toBe("synthid")
    expect(result.variants).toHaveLength(1)
  })

  it("captures the request shape on the recorder", async () => {
    const mock = MockMusicGenerator.layer({
      results: [
        singleVariant({
          audio: {
            format: { container: "mp3", encoding: "mp3", sampleRate: 44100 },
            bytes: fakeBytes(0, 4),
          },
        }),
      ],
    })
    const program = Effect.gen(function* () {
      yield* run({ model: defaultModel.elevenlabs, prompt: "house at 124 bpm" })
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.generateCalls).toHaveLength(1)
    expect(rec.generateCalls[0]!.model).toBe("music_v1")
    expect(rec.generateCalls[0]!.prompt).toBe("house at 124 bpm")
    expect(rec.generateCalls[0]!.duration).toEqual(Duration.seconds(30))
  })

  it("model defaults differ per provider", () => {
    expect(defaultModel.google).toBe("lyria-3-clip-preview")
    expect(defaultModel.elevenlabs).toBe("music_v1")
  })
})
