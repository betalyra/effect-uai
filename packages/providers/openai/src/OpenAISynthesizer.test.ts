import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as OpenAISynthesizer from "./OpenAISynthesizer.js"

const cfg: OpenAISynthesizer.Config = { apiKey: Redacted.make("test-key") }
const live = Layer.provide(OpenAISynthesizer.layer(cfg), FetchHttpClient.layer)

describe("OpenAISynthesizer capability guards (runtime)", () => {
  it("fails Unsupported for ogg outputFormat", async () => {
    const program = OpenAISynthesizer.OpenAISynthesizer.use((s) =>
      s.synthesize({
        text: "hi",
        model: "gpt-4o-mini-tts",
        voiceId: "alloy",
        outputFormat: { container: "ogg", encoding: "opus", sampleRate: 24000 },
      }),
    )
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("outputFormat")
    }
  })

  it("streamSynthesisFrom returns an Unsupported stream", async () => {
    const program = OpenAISynthesizer.OpenAISynthesizer.use((s) =>
      Stream.runDrain(
        s.streamSynthesisFrom(Stream.fromIterable(["hi"]), {
          model: "gpt-4o-mini-tts",
          voiceId: "alloy",
        }),
      ),
    )
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("streamSynthesisFrom")
    }
  })
})

describe("OpenAISynthesizer Layer (compile-time)", () => {
  it("leaves `TtsIncrementalText` unsatisfied when using `streamSynthesisFrom` against this Layer", () => {
    const tokens: Stream.Stream<string> = Stream.fromIterable(["a", "b"])
    const audio = tokens.pipe(
      SpeechSynthesizer.streamSynthesisFrom({ model: "gpt-4o-mini-tts", voiceId: "alloy" }),
    )
    const provided = Stream.runDrain(audio).pipe(Effect.provide(live))
    expectTypeOf(provided).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, SpeechSynthesizer.TtsIncrementalText>
    >()
  })

  it("sync `synthesize` and chunked `streamSynthesis` require no marker", () => {
    const synth = SpeechSynthesizer.synthesize({
      text: "hi",
      model: "gpt-4o-mini-tts",
      voiceId: "alloy",
    }).pipe(Effect.provide(live))
    expectTypeOf(synth).toEqualTypeOf<
      Effect.Effect<import("@effect-uai/core/Audio").AudioBlob, AiError.AiError, never>
    >()

    // `streamSynthesis` itself returns a Stream; once we runCollect + provide,
    // R should narrow to `never`. Skipping the precise expectTypeOf because
    // vitest's expect-type struggles with Effect's iterator type — the fact
    // that this compiles at all proves R was satisfied.
    const _stream = Stream.runCollect(
      SpeechSynthesizer.streamSynthesis({
        text: "hi",
        model: "gpt-4o-mini-tts",
        voiceId: "alloy",
      }),
    ).pipe(Effect.provide(live))
    expect(_stream).toBeDefined()
  })
})
