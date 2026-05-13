import { Effect, Encoding } from "effect"
import { describe, expect, it } from "vitest"
import type { AudioSource } from "@effect-uai/core/Audio"
import { audioToBlob, defaultFileName, formatToOutputSlug, httpStatusError } from "./codec.js"

describe("formatToOutputSlug", () => {
  it("encodes mp3 with default bitrate when omitted", async () => {
    const slug = await Effect.runPromise(
      formatToOutputSlug({ container: "mp3", encoding: "mp3", sampleRate: 44100 }),
    )
    expect(slug).toBe("mp3_44100_128")
  })

  it("honours an explicit mp3 bitrate", async () => {
    const slug = await Effect.runPromise(
      formatToOutputSlug({ container: "mp3", encoding: "mp3", sampleRate: 22050, bitRate: 32 }),
    )
    expect(slug).toBe("mp3_22050_32")
  })

  it("encodes raw pcm_s16le as `pcm_<sampleRate>`", async () => {
    const slug = await Effect.runPromise(
      formatToOutputSlug({ container: "raw", encoding: "pcm_s16le", sampleRate: 16000 }),
    )
    expect(slug).toBe("pcm_16000")
  })

  it("encodes mu-law as `ulaw_<sampleRate>`", async () => {
    const slug = await Effect.runPromise(
      formatToOutputSlug({ container: "raw", encoding: "pcm_mulaw", sampleRate: 8000 }),
    )
    expect(slug).toBe("ulaw_8000")
  })

  it("encodes opus with default bitrate", async () => {
    const slug = await Effect.runPromise(
      formatToOutputSlug({ container: "opus", encoding: "opus", sampleRate: 48000 }),
    )
    expect(slug).toBe("opus_48000_128")
  })

  it("encodes wav as `wav_<sampleRate>`", async () => {
    const slug = await Effect.runPromise(
      formatToOutputSlug({ container: "wav", encoding: "pcm_s16le", sampleRate: 48000 }),
    )
    expect(slug).toBe("wav_48000")
  })

  it("fails Unsupported for flac / aac / webm / ogg", async () => {
    const exit = await Effect.runPromiseExit(
      formatToOutputSlug({ container: "flac", encoding: "flac", sampleRate: 44100 }),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("outputFormat")
    }
  })
})

describe("audioToBlob", () => {
  it("wraps bytes into a Blob with the right MIME type", async () => {
    const source: AudioSource = {
      _tag: "bytes",
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "audio/wav",
    }
    const blob = await Effect.runPromise(audioToBlob(source))
    expect(blob.type).toBe("audio/wav")
    expect(blob.size).toBe(4)
  })

  it("decodes a base64 source into bytes", async () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const source: AudioSource = {
      _tag: "base64",
      base64: Encoding.encodeBase64(original),
      mimeType: "audio/mpeg",
    }
    const blob = await Effect.runPromise(audioToBlob(source))
    expect(blob.type).toBe("audio/mpeg")
    expect(blob.size).toBe(4)
  })

  it("fails InvalidRequest for url sources", async () => {
    const source: AudioSource = { _tag: "url", url: "https://x/y.mp3", mimeType: "audio/mpeg" }
    const exit = await Effect.runPromiseExit(audioToBlob(source))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("InvalidRequest")
      expect(JSON.stringify(exit.cause)).toContain("cloud_storage_url")
    }
  })
})

describe("defaultFileName", () => {
  it("maps audio/mpeg → audio.mp3", () => {
    expect(defaultFileName("audio/mpeg")).toBe("audio.mp3")
  })
  it("maps audio/wav → audio.wav", () => {
    expect(defaultFileName("audio/wav")).toBe("audio.wav")
  })
  it("falls back to audio (no extension) for unknown MIME", () => {
    expect(defaultFileName("application/octet-stream")).toBe("audio")
  })
})

describe("httpStatusError", () => {
  const tags = (status: number) => JSON.parse(JSON.stringify(httpStatusError(status, "body")))._tag
  it("maps 429 to RateLimited", () => expect(tags(429)).toBe("RateLimited"))
  it("maps 408/504 to Timeout", () => {
    expect(tags(408)).toBe("Timeout")
    expect(tags(504)).toBe("Timeout")
  })
  it("maps 401/402/403 to AuthFailed", () => {
    expect(tags(401)).toBe("AuthFailed")
    expect(tags(402)).toBe("AuthFailed")
    expect(tags(403)).toBe("AuthFailed")
  })
  it("maps 5xx to Unavailable", () => {
    expect(tags(500)).toBe("Unavailable")
    expect(tags(503)).toBe("Unavailable")
  })
  it("maps other 4xx to InvalidRequest", () => {
    expect(tags(400)).toBe("InvalidRequest")
    expect(tags(404)).toBe("InvalidRequest")
  })
})
