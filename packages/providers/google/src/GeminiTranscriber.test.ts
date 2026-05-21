import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import type { AudioSource } from "@effect-uai/core/Audio"
import type { TranscriptResult } from "@effect-uai/core/Transcript"
import * as Transcriber from "@effect-uai/core/Transcriber"
import * as GeminiTranscriber from "./GeminiTranscriber.js"

const cfg: GeminiTranscriber.Config = { apiKey: Redacted.make("test-key") }
const live = Layer.provide(GeminiTranscriber.layer(cfg), FetchHttpClient.layer)

const dummyAudio: AudioSource = {
  _tag: "bytes",
  bytes: new Uint8Array([0, 1, 2, 3]),
  mimeType: "audio/wav",
}

describe("GeminiTranscriber.buildPrompt", () => {
  it("uses the language-agnostic prompt when no language is set", () => {
    expect(
      GeminiTranscriber.buildPrompt({ audio: dummyAudio, model: "gemini-2.5-flash" }),
    ).toContain("Transcribe the audio verbatim. Return only the transcript text")
  })

  it("includes the language when set", () => {
    expect(
      GeminiTranscriber.buildPrompt({
        audio: dummyAudio,
        model: "gemini-2.5-flash",
        language: "pt-BR",
      }),
    ).toContain("in pt-BR")
  })

  it("appends a free-text prompt as context", () => {
    const out = GeminiTranscriber.buildPrompt({
      audio: dummyAudio,
      model: "gemini-2.5-flash",
      prompt: "Engineering meeting; expect technical jargon.",
    })
    expect(out).toContain("Context: Engineering meeting")
  })

  it("appends a terms list as biasing vocabulary", () => {
    const out = GeminiTranscriber.buildPrompt({
      audio: dummyAudio,
      model: "gemini-2.5-flash",
      prompt: { terms: ["Effect", "Lyria", "MusicGenerator"] },
    })
    expect(out).toContain("Effect, Lyria, MusicGenerator")
  })

  it("omits the biasing block when the terms list is empty", () => {
    const out = GeminiTranscriber.buildPrompt({
      audio: dummyAudio,
      model: "gemini-2.5-flash",
      prompt: { terms: [] },
    })
    expect(out).not.toContain("terms / names")
  })
})

describe("GeminiTranscriber capability surface", () => {
  it("omits wordTimestamps and diarization from the typed request (compile-time)", () => {
    expectTypeOf<GeminiTranscriber.GeminiTranscribeRequest>().not.toHaveProperty(
      "wordTimestamps",
    )
    expectTypeOf<GeminiTranscriber.GeminiTranscribeRequest>().not.toHaveProperty("diarization")
  })

  it("fails Unsupported for wordTimestamps via the generic Transcriber", async () => {
    const program = Transcriber.transcribe({
      audio: dummyAudio,
      model: "gemini-2.5-flash",
      wordTimestamps: true,
    })
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("wordTimestamps")
    }
  })

  it("fails Unsupported for diarization via the generic Transcriber", async () => {
    const program = Transcriber.transcribe({
      audio: dummyAudio,
      model: "gemini-2.5-flash",
      diarization: true,
    })
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("diarization")
    }
  })

  it("streamTranscriptionFrom returns an Unsupported stream", async () => {
    const program = GeminiTranscriber.GeminiTranscriber.use((s) =>
      Stream.runDrain(
        s.streamTranscriptionFrom(Stream.fromIterable([new Uint8Array([0])]), {
          model: "gemini-2.5-flash",
          inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000 },
        }),
      ),
    )
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("streamTranscriptionFrom")
    }
  })
})

describe("GeminiTranscriber Layer (compile-time)", () => {
  it("leaves `SttStreaming` unsatisfied when using `streamTranscriptionFrom` against this Layer", () => {
    const audio: Stream.Stream<Uint8Array> = Stream.fromIterable([new Uint8Array([0])])
    const events = audio.pipe(
      Transcriber.streamTranscriptionFrom({
        model: "gemini-2.5-flash",
        inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000 },
      }),
    )
    const provided = Stream.runDrain(events).pipe(Effect.provide(live))
    expectTypeOf(provided).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, Transcriber.SttStreaming>
    >()
  })

  it("sync `transcribe` requires no marker", () => {
    const t = Transcriber.transcribe({ audio: dummyAudio, model: "gemini-2.5-flash" }).pipe(
      Effect.provide(live),
    )
    expectTypeOf(t).toEqualTypeOf<Effect.Effect<TranscriptResult, AiError.AiError, never>>()
  })
})
