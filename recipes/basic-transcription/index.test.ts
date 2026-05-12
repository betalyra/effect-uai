import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { AudioSource } from "@effect-uai/core/Audio"
import * as MockTranscriber from "@effect-uai/core/testing/MockTranscriber"
import { transcribeGpt4o, transcribeWhisperVerbose } from "./index.js"

const dummyAudio: AudioSource = {
  _tag: "bytes",
  bytes: new Uint8Array([0, 1, 2, 3]),
  mimeType: "audio/wav",
}

describe("basic-transcription", () => {
  it("returns the gpt-4o-transcribe scripted transcript", async () => {
    const mock = MockTranscriber.layer({
      transcripts: [{ text: "Hello, world." }],
    })
    const result = await Effect.runPromise(
      transcribeGpt4o(dummyAudio).pipe(Effect.provide(mock.layer)),
    )
    expect(result.text).toBe("Hello, world.")
  })

  it("returns word timestamps for the whisper verbose variant", async () => {
    const mock = MockTranscriber.layer({
      transcripts: [
        {
          text: "Hello world",
          languageCode: "en",
          durationSeconds: 1.2,
          words: [
            { text: "Hello", startSeconds: 0.0, endSeconds: 0.5 },
            { text: "world", startSeconds: 0.6, endSeconds: 1.1 },
          ],
        },
      ],
    })
    const result = await Effect.runPromise(
      transcribeWhisperVerbose(dummyAudio).pipe(Effect.provide(mock.layer)),
    )
    expect(result.text).toBe("Hello world")
    expect(result.languageCode).toBe("en")
    expect(result.words?.length).toBe(2)
    expect(result.words?.[0]).toEqual({ text: "Hello", startSeconds: 0, endSeconds: 0.5 })
  })

  it("captures the model and request shape on the mock recorder", async () => {
    const mock = MockTranscriber.layer({
      transcripts: [{ text: "a" }, { text: "b" }],
    })
    const program = Effect.gen(function* () {
      yield* transcribeGpt4o(dummyAudio)
      yield* transcribeWhisperVerbose(dummyAudio)
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.transcribeCalls.map((c) => c.model)).toEqual(["gpt-4o-transcribe", "whisper-1"])
    expect(rec.transcribeCalls[1]?.wordTimestamps).toBe(true)
  })
})
