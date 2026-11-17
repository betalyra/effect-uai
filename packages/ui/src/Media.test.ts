import * as Pcm from "@effect-uai/core/Pcm"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as Media from "./Media.js"

describe("Media.level", () => {
  it.effect("is the RMS of each frame", () =>
    Effect.gen(function* () {
      const levels = yield* Stream.make(
        Pcm.f32ToS16le(new Float32Array([0, 0])),
        Pcm.f32ToS16le(new Float32Array([0.5, -0.5])),
      ).pipe(Media.level, Stream.runCollect)
      expect(levels[0]).toBe(0)
      expect(levels[1]).toBeCloseTo(0.5, 3)
    }),
  )
})
