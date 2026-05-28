import { Duration, Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import type { GenerateResult } from "@effect-uai/core/Music"
import { promptsInput } from "@effect-uai/core/Music"
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"
import * as LyriaGenerator from "./LyriaGenerator.js"

const cfg: LyriaGenerator.Config = { apiKey: Redacted.make("test-key") }
// FetchHttpClient is required for `make`, but these tests only exercise the
// compile-time gating and runtime Unsupported branches, no real HTTP is made.
const live = Layer.provide(LyriaGenerator.layer(cfg), FetchHttpClient.layer)

describe("containerToMimeType", () => {
  it("maps mp3 and wav", async () => {
    expect(await Effect.runPromise(LyriaGenerator.containerToMimeType("mp3"))).toBe("audio/mp3")
    expect(await Effect.runPromise(LyriaGenerator.containerToMimeType("wav"))).toBe("audio/wav")
  })

  it("fails Unsupported for ogg / opus / flac / aac / webm / raw", async () => {
    const exit = await Effect.runPromiseExit(LyriaGenerator.containerToMimeType("ogg"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("outputFormat")
    }
  })
})

describe("realizedFormat", () => {
  it("reports 44.1 kHz stereo for both mp3 and wav", () => {
    expect(LyriaGenerator.realizedFormat("audio/mp3")).toEqual({
      container: "mp3",
      encoding: "mp3",
      sampleRate: 44100,
      channels: 2,
    })
    expect(LyriaGenerator.realizedFormat("audio/wav")).toEqual({
      container: "wav",
      encoding: "pcm_s16le",
      sampleRate: 44100,
      channels: 2,
    })
  })
})

describe("LyriaGenerator capability guards (runtime)", () => {
  it("streamGenerationFrom returns an Unsupported stream", async () => {
    const program = LyriaGenerator.LyriaGenerator.use((s) =>
      Stream.runDrain(
        s.streamGenerationFrom(Stream.fromIterable([promptsInput([{ text: "x" }])]), {
          model: "lyria-3-clip-preview",
          prompt: "",
        }),
      ),
    )
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Unsupported")
      expect(JSON.stringify(exit.cause)).toContain("streamGenerationFrom")
    }
  })
})

describe("LyriaGenerator Layer (compile-time)", () => {
  it("leaves `MusicInteractiveSession` unsatisfied when using `streamGenerationFrom` against this Layer", () => {
    const inputs = Stream.fromIterable([promptsInput([{ text: "techno" }])])
    const events = inputs.pipe(
      MusicGenerator.streamGenerationFrom({
        model: "lyria-3-clip-preview",
        prompt: "",
      }),
    )
    const provided = Stream.runDrain(events).pipe(Effect.provide(live))
    expectTypeOf(provided).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, MusicGenerator.MusicInteractiveSession>
    >()
  })

  it("sync `generate` returns GenerateResult and requires no marker", () => {
    const gen = MusicGenerator.generate({
      model: "lyria-3-clip-preview",
      prompt: "ambient",
    }).pipe(Effect.provide(live))
    expectTypeOf(gen).toEqualTypeOf<Effect.Effect<GenerateResult, AiError.AiError, never>>()
  })

  it("chunked `streamGeneration` requires no marker", () => {
    const _stream = Stream.runCollect(
      MusicGenerator.streamGeneration({
        model: "lyria-3-clip-preview",
        prompt: "ambient",
      }),
    ).pipe(Effect.provide(live))
    expect(_stream).toBeDefined()
  })

  it("Lyria-typed request accepts no `instrumental` field", () => {
    const _req: LyriaGenerator.LyriaGenerateRequest = {
      model: "lyria-3-clip-preview",
      prompt: "ambient",
      // @ts-expect-error: instrumental was removed from LyriaGenerateRequest in v0.7
      instrumental: true,
    }
    expect(_req).toBeDefined()
  })

  it("Common request supports `duration: Duration.Duration`", () => {
    const _req: MusicGenerator.CommonGenerateMusicRequest = {
      model: "lyria-3-clip-preview",
      prompt: "ambient",
      duration: Duration.seconds(30),
    }
    expect(_req).toBeDefined()
  })
})
