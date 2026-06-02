import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import * as Transcriber from "@effect-uai/core/Transcriber"
import * as OpenAITranscriber from "./OpenAITranscriber.js"

const cfg: OpenAITranscriber.Config = { apiKey: Redacted.make("test-key") }

// FetchHttpClient is required for `make`, but these tests only exercise the
// request-validation path that fails *before* the HTTP call goes out.
const live = Layer.provide(OpenAITranscriber.layer(cfg), FetchHttpClient.layer)

describe("OpenAITranscriber capability guards (runtime)", () => {
  it("streamTranscriptionFrom returns an Unsupported stream", async () => {
    const program = OpenAITranscriber.OpenAITranscriber.use((t) =>
      Stream.runDrain(
        t.streamTranscriptionFrom(Stream.fromIterable<Uint8Array>([new Uint8Array([0])]), {
          model: "gpt-4o-transcribe",
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

describe("OpenAITranscriber Layer (compile-time)", () => {
  it("leaves `SttStreaming` unsatisfied when using `streamTranscriptionFrom` against this Layer", () => {
    const audio: Stream.Stream<Uint8Array> = Stream.fromIterable([new Uint8Array([0])])
    const events = audio.pipe(
      Transcriber.streamTranscriptionFrom({
        model: "gpt-4o-transcribe",
        inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000 },
      }),
    )
    const provided = Stream.runDrain(events).pipe(Effect.provide(live))
    // `Transcriber` is provided; `SttStreaming` is NOT — calling
    // `Effect.runPromise(provided)` would be a type error because R is
    // non-`never`.
    expectTypeOf(provided).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, Transcriber.SttStreaming>
    >()
  })

  it("sync `transcribe` requires no marker and clears R to never", () => {
    const eff = Transcriber.transcribe({
      audio: { _tag: "bytes", bytes: new Uint8Array([0]), mimeType: "audio/wav" },
      model: "whisper-1",
    }).pipe(Effect.provide(live))
    expectTypeOf(eff).toEqualTypeOf<
      Effect.Effect<import("@effect-uai/core/Transcript").TranscriptResult, AiError.AiError, never>
    >()
  })
})
