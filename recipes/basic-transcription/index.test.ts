import { Duration, Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { AudioSource } from "@effect-uai/core/Audio"
import * as MockTranscriber from "@effect-uai/core/testing/MockTranscriber"
import { transcribeFast, transcribeVerbose, type Provider } from "./index.js"

const dummyAudio: AudioSource = {
  _tag: "bytes",
  bytes: new Uint8Array([0, 1, 2, 3]),
  mimeType: "audio/wav",
}

const providers: ReadonlyArray<Provider> = ["openai", "elevenlabs"]

describe.each(providers)("basic-transcription fast (%s)", (provider) => {
  it("returns the scripted transcript", async () => {
    const mock = MockTranscriber.layer({ transcripts: [{ text: "Hello, world." }] })
    const result = await Effect.runPromise(
      transcribeFast(provider, dummyAudio).pipe(Effect.provide(mock.layer)),
    )
    expect(result.text).toBe("Hello, world.")
  })
})

describe("basic-transcription verbose (openai-only)", () => {
  it("returns word timestamps", async () => {
    const mock = MockTranscriber.layer({
      transcripts: [
        {
          text: "Hello world",
          languageCode: "en",
          duration: Duration.seconds(1.2),
          words: [
            { text: "Hello", startSeconds: 0.0, endSeconds: 0.5 },
            { text: "world", startSeconds: 0.6, endSeconds: 1.1 },
          ],
        },
      ],
    })
    const result = await Effect.runPromise(
      transcribeVerbose(dummyAudio).pipe(Effect.provide(mock.layer)),
    )
    expect(result.text).toBe("Hello world")
    expect(result.languageCode).toBe("en")
    expect(result.words?.length).toBe(2)
    expect(result.words?.[0]).toEqual({ text: "Hello", startSeconds: 0, endSeconds: 0.5 })
  })
})

describe("basic-transcription provider dispatch", () => {
  it("sends each provider's expected model on the request", async () => {
    const mock = MockTranscriber.layer({
      transcripts: [{ text: "a" }, { text: "b" }, { text: "c" }],
    })
    const program = Effect.gen(function* () {
      yield* transcribeFast("openai", dummyAudio)
      yield* transcribeFast("elevenlabs", dummyAudio)
      yield* transcribeVerbose(dummyAudio)
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.transcribeCalls.map((c) => c.model)).toEqual([
      "gpt-4o-transcribe",
      "scribe_v2",
      "whisper-1",
    ])
    expect(rec.transcribeCalls[2]?.wordTimestamps).toBe(true)
  })
})
