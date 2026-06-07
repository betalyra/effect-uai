import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as GeminiSynthesizer from "./GeminiSynthesizer.js"

describe("GeminiSynthesizer.realizeOutput", () => {
  it("maps raw to native PCM 24 kHz mono with an identity wrapper", () => {
    const result = GeminiSynthesizer.realizeOutput("raw")
    expect(Result.isSuccess(result)).toBe(true)
    const [format, wrap] = Result.getOrThrow(result)
    expect(format).toEqual({
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 24000,
      channels: 1,
    })
    const pcm = new Uint8Array([1, 2, 3, 4])
    expect(wrap(pcm)).toBe(pcm)
  })

  it("maps wav to a RIFF/WAVE wrapper that prepends a 44-byte header", () => {
    const [format, wrap] = Result.getOrThrow(GeminiSynthesizer.realizeOutput("wav"))
    expect(format.container).toBe("wav")
    const out = wrap(new Uint8Array([0, 1, 2, 3]))
    expect(out.length).toBe(44 + 4)
    const ascii = (start: number, len: number) =>
      String.fromCharCode(...Array.from(out.slice(start, start + len)))
    expect(ascii(0, 4)).toBe("RIFF")
    expect(ascii(8, 4)).toBe("WAVE")
    expect(ascii(12, 4)).toBe("fmt ")
    expect(ascii(36, 4)).toBe("data")
  })

  it("fails Unsupported for mp3 / opus / aac / flac / ogg / webm", () => {
    const result = GeminiSynthesizer.realizeOutput("mp3")
    expect(Result.isFailure(result)).toBe(true)
    expect(JSON.stringify(result)).toContain("Unsupported")
    expect(JSON.stringify(result)).toContain("outputFormat")
  })
})
