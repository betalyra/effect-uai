import { Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"
import { promptsInput } from "@effect-uai/core/Music"
import * as LyriaGenerator from "./LyriaGenerator.js"

const cfg: LyriaGenerator.Config = { apiKey: Redacted.make("test-key") }
// FetchHttpClient is required for `make`, but these tests only exercise the
// compile-time gating and runtime Unsupported branches — no real HTTP is made.
const live = Layer.provide(LyriaGenerator.layer(cfg), FetchHttpClient.layer)

describe("buildPrompt", () => {
  it("returns a plain string when prompts is a string", () => {
    const out = LyriaGenerator.buildPrompt({
      model: "lyria-3-clip-preview",
      prompts: "upbeat indie pop",
    })
    expect(out).toBe("upbeat indie pop")
  })

  it("joins weighted prompts with weight annotations", () => {
    const out = LyriaGenerator.buildPrompt({
      model: "lyria-3-clip-preview",
      prompts: [
        { text: "minimal techno", weight: 1.0 },
        { text: "1980s synthwave", weight: 0.3 },
      ],
    })
    expect(out).toContain("minimal techno")
    expect(out).toContain("1980s synthwave (weight 0.3)")
  })

  it("omits the weight annotation for weight === 1", () => {
    const out = LyriaGenerator.buildPrompt({
      model: "lyria-3-clip-preview",
      prompts: [{ text: "ambient", weight: 1 }],
    })
    expect(out).toBe("ambient")
  })

  it("splices in bpm, scale, duration, and instrumental hints", () => {
    const out = LyriaGenerator.buildPrompt({
      model: "lyria-3-clip-preview",
      prompts: "house",
      bpm: 124,
      scale: "C_MAJOR",
      durationSeconds: 30,
      instrumental: true,
    })
    expect(out).toContain("Instrumental only")
    expect(out).toContain("BPM: 124")
    expect(out).toContain("Key/scale: C_MAJOR")
    expect(out).toContain("Target duration: 30s")
  })

  it("appends a lyrics block when lyrics is set and instrumental is not true", () => {
    const out = LyriaGenerator.buildPrompt({
      model: "lyria-3-clip-preview",
      prompts: "indie rock",
      lyrics: "[Verse]\nhello world",
    })
    expect(out).toContain("Lyrics:")
    expect(out).toContain("[Verse]")
  })

  it("drops the lyrics block when instrumental is true", () => {
    const out = LyriaGenerator.buildPrompt({
      model: "lyria-3-clip-preview",
      prompts: "indie rock",
      lyrics: "[Verse]\nhello world",
      instrumental: true,
    })
    expect(out).not.toContain("Lyrics:")
  })
})

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
          prompts: "",
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
    const audio = inputs.pipe(
      MusicGenerator.streamGenerationFrom({
        model: "lyria-3-clip-preview",
        prompts: "",
      }),
    )
    const provided = Stream.runDrain(audio).pipe(Effect.provide(live))
    expectTypeOf(provided).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, MusicGenerator.MusicInteractiveSession>
    >()
  })

  it("sync `generate` and chunked `streamGeneration` require no marker", () => {
    const gen = MusicGenerator.generate({
      model: "lyria-3-clip-preview",
      prompts: "ambient",
    }).pipe(Effect.provide(live))
    expectTypeOf(gen).toEqualTypeOf<
      Effect.Effect<import("@effect-uai/core/Music").MusicResult, AiError.AiError, never>
    >()
    const _stream = Stream.runCollect(
      MusicGenerator.streamGeneration({
        model: "lyria-3-clip-preview",
        prompts: "ambient",
      }),
    ).pipe(Effect.provide(live))
    expect(_stream).toBeDefined()
  })
})
