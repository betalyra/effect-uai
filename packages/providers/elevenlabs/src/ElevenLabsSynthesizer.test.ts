import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob } from "@effect-uai/core/Audio"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as ElevenLabsSynthesizer from "./ElevenLabsSynthesizer.js"

const cfg: ElevenLabsSynthesizer.Config = { apiKey: Redacted.make("test-key") }
// FetchHttpClient is required for `make`, but these tests only exercise the
// compile-time / runtime Unsupported branches — no real HTTP call is made.
const live = Layer.provide(ElevenLabsSynthesizer.layer(cfg), FetchHttpClient.layer)

describe("ElevenLabsSynthesizer capability guards (runtime)", () => {
  it("streamSynthesisFrom returns an Unsupported stream", async () => {
    const program = ElevenLabsSynthesizer.ElevenLabsSynthesizer.use((s) =>
      Stream.runDrain(
        s.streamSynthesisFrom(Stream.fromIterable(["hi"]), {
          model: "eleven_multilingual_v2",
          voiceId: "JBFqnCBsd6RMkjVDRZzb",
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

describe("ElevenLabsSynthesizer Layer (compile-time)", () => {
  it("leaves `TtsIncrementalText` unsatisfied when using `streamSynthesisFrom` against this Layer", () => {
    const tokens: Stream.Stream<string> = Stream.fromIterable(["a", "b"])
    const audio = tokens.pipe(
      SpeechSynthesizer.streamSynthesisFrom({
        model: "eleven_multilingual_v2",
        voiceId: "JBFqnCBsd6RMkjVDRZzb",
      }),
    )
    const provided = Stream.runDrain(audio).pipe(Effect.provide(live))
    expectTypeOf(provided).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, SpeechSynthesizer.TtsIncrementalText>
    >()
  })

  it("sync `synthesize` and chunked `streamSynthesis` require no marker", () => {
    const synth = SpeechSynthesizer.synthesize({
      text: "hi",
      model: "eleven_multilingual_v2",
      voiceId: "JBFqnCBsd6RMkjVDRZzb",
    }).pipe(Effect.provide(live))
    expectTypeOf(synth).toEqualTypeOf<Effect.Effect<AudioBlob, AiError.AiError, never>>()

    const _stream = Stream.runCollect(
      SpeechSynthesizer.streamSynthesis({
        text: "hi",
        model: "eleven_multilingual_v2",
        voiceId: "JBFqnCBsd6RMkjVDRZzb",
      }),
    ).pipe(Effect.provide(live))
    expect(_stream).toBeDefined()
  })
})
