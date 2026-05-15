import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import type { AudioBlob } from "@effect-uai/core/Audio"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"
import * as GeminiSynthesizer from "./GeminiSynthesizer.js"

const cfg: GeminiSynthesizer.Config = { apiKey: Redacted.make("test-key") }
// FetchHttpClient is required for `make`, but these tests only exercise
// the codec and the compile-time / runtime Unsupported branches — no
// real HTTP call is made.
const live = Layer.provide(GeminiSynthesizer.layer(cfg), FetchHttpClient.layer)

describe("GeminiSynthesizer.realizeOutput", () => {
  it("maps raw to native PCM 24 kHz mono with an identity wrapper", async () => {
    const [format, wrap] = await Effect.runPromise(GeminiSynthesizer.realizeOutput("raw"))
    expect(format).toEqual({
      container: "raw",
      encoding: "pcm_s16le",
      sampleRate: 24000,
      channels: 1,
    })
    const pcm = new Uint8Array([1, 2, 3, 4])
    expect(wrap(pcm)).toBe(pcm)
  })

  it("maps wav to a RIFF/WAVE wrapper that prepends a 44-byte header", async () => {
    const [format, wrap] = await Effect.runPromise(GeminiSynthesizer.realizeOutput("wav"))
    expect(format.container).toBe("wav")
    const out = wrap(new Uint8Array([0, 1, 2, 3]))
    expect(out.length).toBe(44 + 4)
    const ascii = (start: number, len: number) =>
      String.fromCharCode(...Array.from(out.slice(start, start + len)))
    expect(ascii(0, 4)).toBe("RIFF")
    expect(ascii(8, 4)).toBe("WAVE")
    expect(ascii(12, 4)).toBe("fmt ")
    expect(ascii(36, 4)).toBe("data")
  })

  it("fails Unsupported for mp3 / opus / aac / flac / ogg / webm", async () => {
    const exit = await Effect.runPromiseExit(GeminiSynthesizer.realizeOutput("mp3"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("outputFormat")
    }
  })
})

describe("GeminiSynthesizer capability guards (runtime)", () => {
  it("streamSynthesisFrom returns an Unsupported stream", async () => {
    const program = GeminiSynthesizer.GeminiSynthesizer.use((s) =>
      Stream.runDrain(
        s.streamSynthesisFrom(Stream.fromIterable(["hi"]), {
          model: "gemini-2.5-flash-preview-tts",
          voiceId: "Kore",
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

describe("GeminiSynthesizer Layer (compile-time)", () => {
  it("leaves `TtsIncrementalText` unsatisfied when using `streamSynthesisFrom` against this Layer", () => {
    const tokens: Stream.Stream<string> = Stream.fromIterable(["a"])
    const audio = tokens.pipe(
      SpeechSynthesizer.streamSynthesisFrom({
        model: "gemini-2.5-flash-preview-tts",
        voiceId: "Kore",
      }),
    )
    const provided = Stream.runDrain(audio).pipe(Effect.provide(live))
    expectTypeOf(provided).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, SpeechSynthesizer.TtsIncrementalText>
    >()
  })

  it("sync `synthesize` requires no marker", () => {
    const synth = SpeechSynthesizer.synthesize({
      text: "hi",
      model: "gemini-2.5-flash-preview-tts",
      voiceId: "Kore",
    }).pipe(Effect.provide(live))
    expectTypeOf(synth).toEqualTypeOf<Effect.Effect<AudioBlob, AiError.AiError, never>>()
  })
})
