import { Effect, Encoding } from "effect"
import { describe, expect, it } from "vitest"
import * as AiError from "@effect-uai/core/AiError"
import type { AudioSource } from "@effect-uai/core/Audio"
import {
  audioToBlob,
  containerToResponseFormat,
  defaultFileName,
  httpStatusError,
  realizedFormat,
} from "./codec.js"

describe("audioToBlob", () => {
  it("converts a `bytes` AudioSource to a Blob with the right MIME type", async () => {
    const source: AudioSource = {
      _tag: "bytes",
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "audio/wav",
    }
    const blob = await Effect.runPromise(audioToBlob(source))
    expect(blob.type).toBe("audio/wav")
    expect(blob.size).toBe(4)
  })

  it("decodes a `base64` AudioSource into bytes", async () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const source: AudioSource = {
      _tag: "base64",
      base64: Encoding.encodeBase64(original),
      mimeType: "audio/mpeg",
    }
    const blob = await Effect.runPromise(audioToBlob(source))
    expect(blob.type).toBe("audio/mpeg")
    expect(blob.size).toBe(4)
    const buf = new Uint8Array(await blob.arrayBuffer())
    expect(Array.from(buf)).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it("rejects `url` AudioSource with InvalidRequest", async () => {
    const source: AudioSource = {
      _tag: "url",
      url: "https://example.com/audio.mp3",
      mimeType: "audio/mpeg",
    }
    const exit = await Effect.runPromiseExit(audioToBlob(source))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const err = exit.cause
      // Stringify-and-match keeps this test resilient to Cause shape changes.
      expect(JSON.stringify(err)).toContain("InvalidRequest")
      expect(JSON.stringify(err)).toContain("OpenAI does not accept URL audio")
    }
  })

  it("rejects malformed base64 with InvalidRequest", async () => {
    const source: AudioSource = {
      _tag: "base64",
      base64: "!!!not-base64!!!",
      mimeType: "audio/wav",
    }
    const exit = await Effect.runPromiseExit(audioToBlob(source))
    expect(exit._tag).toBe("Failure")
  })
})

describe("defaultFileName", () => {
  it.each([
    ["audio/mpeg", "audio.mp3"],
    ["audio/mp3", "audio.mp3"],
    ["audio/wav", "audio.wav"],
    ["audio/x-wav", "audio.wav"],
    ["audio/ogg", "audio.ogg"],
    ["audio/opus", "audio.ogg"],
    ["audio/flac", "audio.flac"],
    ["audio/aac", "audio.aac"],
    ["audio/mp4", "audio.m4a"],
    ["audio/m4a", "audio.m4a"],
    ["audio/webm", "audio.webm"],
  ])("maps %s → %s", (mime, expected) => {
    expect(defaultFileName(mime)).toBe(expected)
  })

  it("falls back to `audio` for unknown MIME types", () => {
    expect(defaultFileName("application/octet-stream")).toBe("audio")
    expect(defaultFileName("")).toBe("audio")
  })
})

describe("containerToResponseFormat", () => {
  it.each([
    ["mp3", "mp3"],
    ["opus", "opus"],
    ["aac", "aac"],
    ["flac", "flac"],
    ["wav", "wav"],
    ["raw", "pcm"],
  ] as const)("maps %s → %s", async (container, expected) => {
    const out = await Effect.runPromise(containerToResponseFormat(container))
    expect(out).toBe(expected)
  })

  it.each(["ogg", "webm"] as const)("fails Unsupported for %s", async (container) => {
    const exit = await Effect.runPromiseExit(containerToResponseFormat(container))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
    }
  })
})

describe("realizedFormat", () => {
  it("returns a 24 kHz format for every response_format", () => {
    expect(realizedFormat("mp3").sampleRate).toBe(24000)
    expect(realizedFormat("opus").container).toBe("opus")
    expect(realizedFormat("wav")).toEqual({
      container: "wav",
      encoding: "pcm_s16le",
      sampleRate: 24000,
    })
    expect(realizedFormat("pcm")).toEqual({
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 24000,
    })
  })
})

describe("httpStatusError", () => {
  it.each([
    [429, "RateLimited"],
    [408, "Timeout"],
    [504, "Timeout"],
    [401, "AuthFailed"],
    [403, "AuthFailed"],
    [402, "AuthFailed"],
    [413, "ContextLengthExceeded"],
    [500, "Unavailable"],
    [502, "Unavailable"],
    [400, "InvalidRequest"],
    [404, "InvalidRequest"],
  ])("maps %s → %s", (status, expectedTag) => {
    const err = httpStatusError(status, "body")
    expect(err._tag).toBe(expectedTag)
    if ("provider" in err) {
      expect(err.provider).toBe("openai")
    }
  })

  it("carries `subtype` on AuthFailed by status code", () => {
    expect((httpStatusError(401, "x") as AiError.AuthFailed).subtype).toBe("auth")
    expect((httpStatusError(403, "x") as AiError.AuthFailed).subtype).toBe("permission")
    expect((httpStatusError(402, "x") as AiError.AuthFailed).subtype).toBe("billing")
  })
})
