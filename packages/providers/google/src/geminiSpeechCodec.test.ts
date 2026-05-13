import { Effect, Encoding } from "effect"
import { describe, expect, it } from "vitest"
import type { AudioSource } from "@effect-uai/core/Audio"
import { audioSourceToInlineData, wrapPcmAsWav } from "./geminiSpeechCodec.js"

describe("audioSourceToInlineData", () => {
  it("encodes a `bytes` source to base64 with its MIME type", async () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const source: AudioSource = { _tag: "bytes", bytes: original, mimeType: "audio/wav" }
    const inline = await Effect.runPromise(audioSourceToInlineData(source))
    expect(inline.mimeType).toBe("audio/wav")
    expect(inline.data).toBe(Encoding.encodeBase64(original))
  })

  it("passes a `base64` source through unchanged", async () => {
    const b64 = Encoding.encodeBase64(new Uint8Array([1, 2, 3]))
    const source: AudioSource = { _tag: "base64", base64: b64, mimeType: "audio/mp3" }
    const inline = await Effect.runPromise(audioSourceToInlineData(source))
    expect(inline.mimeType).toBe("audio/mp3")
    expect(inline.data).toBe(b64)
  })

  it("fails InvalidRequest for a URL source", async () => {
    const source: AudioSource = { _tag: "url", url: "https://x/y.mp3", mimeType: "audio/mp3" }
    const exit = await Effect.runPromiseExit(audioSourceToInlineData(source))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("InvalidRequest")
      expect(JSON.stringify(exit.cause)).toContain("Files API")
    }
  })
})

describe("wrapPcmAsWav", () => {
  it("produces a 44-byte RIFF/WAVE header for 16-bit mono PCM at 24 kHz", () => {
    const pcm = new Uint8Array([0x00, 0x01, 0x00, 0x02])
    const wav = wrapPcmAsWav(pcm, 24000, 1, 16)
    expect(wav.length).toBe(44 + pcm.length)
    const ascii = (start: number, len: number) =>
      String.fromCharCode(...Array.from(wav.slice(start, start + len)))
    expect(ascii(0, 4)).toBe("RIFF")
    expect(ascii(8, 4)).toBe("WAVE")
    expect(ascii(12, 4)).toBe("fmt ")
    expect(ascii(36, 4)).toBe("data")
    // RIFF chunk size = total - 8
    const view = new DataView(wav.buffer)
    expect(view.getUint32(4, true)).toBe(wav.length - 8)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(24000) // sample rate
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(view.getUint32(40, true)).toBe(pcm.length) // data size
    // Payload preserved
    expect(Array.from(wav.slice(44))).toEqual(Array.from(pcm))
  })
})
