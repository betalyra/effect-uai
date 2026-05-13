import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MockMusicGenerator from "@effect-uai/core/testing/MockMusicGenerator"
import { generateSimple, generateWeighted } from "./index.js"

const fakeBytes = (label: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (label + i) & 0xff)

describe("basic-music-generation", () => {
  it("returns the scripted MusicResult for the simple variant", async () => {
    const mock = MockMusicGenerator.layer({
      results: [
        {
          format: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
          bytes: fakeBytes(0, 32),
          durationSeconds: 30,
          watermark: { kind: "synthid" },
        },
      ],
    })
    const result = await Effect.runPromise(generateSimple.pipe(Effect.provide(mock.layer)))
    expect(result.bytes.length).toBe(32)
    expect(result.format.container).toBe("mp3")
    expect(result.watermark?.kind).toBe("synthid")
  })

  it("returns the scripted MusicResult for the weighted variant with lyrics", async () => {
    const mock = MockMusicGenerator.layer({
      results: [
        {
          format: { container: "mp3", encoding: "mp3", sampleRate: 44100, channels: 2 },
          bytes: fakeBytes(0, 64),
          durationSeconds: 120,
          lyrics: "[Verse]\nNeon city, midnight drive",
          watermark: { kind: "synthid" },
        },
      ],
    })
    const result = await Effect.runPromise(generateWeighted.pipe(Effect.provide(mock.layer)))
    expect(result.bytes.length).toBe(64)
    expect(result.format.container).toBe("mp3")
    expect(result.lyrics).toContain("Neon city")
  })

  it("captures the request shapes on the recorder", async () => {
    const mock = MockMusicGenerator.layer({
      results: [
        {
          format: { container: "mp3", encoding: "mp3", sampleRate: 44100 },
          bytes: fakeBytes(0, 4),
        },
        {
          format: { container: "mp3", encoding: "mp3", sampleRate: 44100 },
          bytes: fakeBytes(0, 4),
        },
      ],
    })
    const program = Effect.gen(function* () {
      yield* generateSimple
      yield* generateWeighted
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.generateCalls.map((c) => c.model)).toEqual([
      "lyria-3-clip-preview",
      "lyria-3-clip-preview",
    ])
    expect(rec.generateCalls[1]!.bpm).toBe(100)
    expect(rec.generateCalls[1]!.scale).toBe("A_MINOR")
    expect(Array.isArray(rec.generateCalls[1]!.prompts)).toBe(true)
  })
})
