import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import type { TranscriptResult } from "@effect-uai/core/Transcript"
import * as Transcriber from "@effect-uai/core/Transcriber"
import * as ElevenLabsTranscriber from "./ElevenLabsTranscriber.js"

const cfg: ElevenLabsTranscriber.Config = { apiKey: Redacted.make("test-key") }
const live = Layer.provide(ElevenLabsTranscriber.layer(cfg), FetchHttpClient.layer)

const dummyAudio = {
  _tag: "bytes" as const,
  bytes: new Uint8Array([0, 1, 2, 3]),
  mimeType: "audio/wav" as const,
}

describe("ElevenLabsTranscriber capability guards (runtime)", () => {
  it("streamTranscriptionFrom returns an Unsupported stream", async () => {
    const program = ElevenLabsTranscriber.ElevenLabsTranscriber.use((s) =>
      Stream.runDrain(
        s.streamTranscriptionFrom(Stream.fromIterable([new Uint8Array([0])]), {
          model: "scribe_v2",
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

describe("ElevenLabsTranscriber Layer (compile-time)", () => {
  it("leaves `SttStreaming` unsatisfied when using `streamTranscriptionFrom` against this Layer", () => {
    const audio: Stream.Stream<Uint8Array> = Stream.fromIterable([new Uint8Array([0])])
    const events = audio.pipe(
      Transcriber.streamTranscriptionFrom({
        model: "scribe_v2",
        inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000 },
      }),
    )
    const provided = Stream.runDrain(events).pipe(Effect.provide(live))
    expectTypeOf(provided).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, Transcriber.SttStreaming>
    >()
  })

  it("sync `transcribe` requires no marker", () => {
    const t = Transcriber.transcribe({ audio: dummyAudio, model: "scribe_v2" }).pipe(
      Effect.provide(live),
    )
    expectTypeOf(t).toEqualTypeOf<Effect.Effect<TranscriptResult, AiError.AiError, never>>()
  })
})
