import { Duration, Effect, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import type { GenerateResult } from "@effect-uai/core/Music"
import { promptsInput } from "@effect-uai/core/Music"
import * as MusicGenerator from "@effect-uai/core/MusicGenerator"
import * as ElevenLabsMusicGenerator from "./ElevenLabsMusicGenerator.js"

const cfg: ElevenLabsMusicGenerator.Config = { apiKey: Redacted.make("test-key") }
const live = Layer.provide(ElevenLabsMusicGenerator.layer(cfg), FetchHttpClient.layer)

describe("ElevenLabsMusicGenerator capability guards (runtime)", () => {
  it("streamGenerationFrom returns an Unsupported stream", async () => {
    const program = ElevenLabsMusicGenerator.ElevenLabsMusicGenerator.use((s) =>
      Stream.runDrain(
        s.streamGenerationFrom(Stream.fromIterable([promptsInput([{ text: "x" }])]), {
          model: "music_v1",
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

describe("ElevenLabsMusicGenerator Layer (compile-time)", () => {
  it("leaves `MusicInteractiveSession` unsatisfied via the generic surface", () => {
    const inputs = Stream.fromIterable([promptsInput([{ text: "techno" }])])
    const events = inputs.pipe(
      MusicGenerator.streamGenerationFrom({ model: "music_v1", prompt: "" }),
    )
    const provided = Stream.runDrain(events).pipe(Effect.provide(live))
    expectTypeOf(provided).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, MusicGenerator.MusicInteractiveSession>
    >()
  })

  it("sync `generate` returns GenerateResult and requires no marker", () => {
    const gen = MusicGenerator.generate({ model: "music_v1", prompt: "house" }).pipe(
      Effect.provide(live),
    )
    expectTypeOf(gen).toEqualTypeOf<Effect.Effect<GenerateResult, AiError.AiError, never>>()
  })

  it("typed request accepts compositionPlan, forceInstrumental, signWithC2pa", () => {
    const _req: ElevenLabsMusicGenerator.ElevenLabsMusicGenerateRequest = {
      model: "music_v1",
      prompt: "",
      compositionPlan: {
        positiveGlobalStyles: ["lo-fi", "warm"],
        negativeGlobalStyles: ["distorted"],
        sections: [
          {
            sectionName: "Intro",
            positiveLocalStyles: ["piano"],
            negativeLocalStyles: [],
            duration: Duration.seconds(15),
            lines: [],
          },
        ],
      },
      forceInstrumental: true,
      signWithC2pa: true,
    }
    expect(_req).toBeDefined()
  })
})

describe("ElevenLabsMusicGenerator codec validation (runtime, no HTTP)", () => {
  it("rejects compositionPlan + non-empty prompt", async () => {
    const program = ElevenLabsMusicGenerator.ElevenLabsMusicGenerator.use((s) =>
      s.generate({
        model: "music_v1",
        prompt: "house",
        compositionPlan: {
          positiveGlobalStyles: [],
          negativeGlobalStyles: [],
          sections: [],
        },
      }),
    )
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("InvalidRequest")
      expect(JSON.stringify(exit.cause)).toContain("mutually exclusive")
    }
  })

  it("rejects compositionPlan + duration", async () => {
    const program = ElevenLabsMusicGenerator.ElevenLabsMusicGenerator.use((s) =>
      s.generate({
        model: "music_v1",
        prompt: "",
        duration: Duration.seconds(30),
        compositionPlan: {
          positiveGlobalStyles: [],
          negativeGlobalStyles: [],
          sections: [],
        },
      }),
    )
    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("InvalidRequest")
      expect(JSON.stringify(exit.cause)).toContain("`duration` is ignored")
    }
  })
})
