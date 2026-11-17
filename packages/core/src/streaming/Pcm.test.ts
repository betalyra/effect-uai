import { describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { expect } from "vitest"
import * as Pcm from "./Pcm.js"

describe("Pcm", () => {
  it("converts 16-bit samples at an odd byte offset", () => {
    // One padding byte, then -32768, 0, 32767 little-endian.
    const buffer = new Uint8Array([9, 0x00, 0x80, 0x00, 0x00, 0xff, 0x7f])
    expect(Array.from(Pcm.s16leToF32(buffer.subarray(1)))).toEqual([-1, 0, 1])
  })

  it("clamps floats on the way to 16-bit", () => {
    const bytes = Pcm.f32ToS16le(new Float32Array([-2, 1.5]))
    expect(Array.from(bytes)).toEqual([0x00, 0x80, 0xff, 0x7f])
  })

  it("reads 32-bit floats and writes them as 16-bit", () => {
    const floats = new Uint8Array(new Float32Array([0.5, -0.5]).buffer)
    expect(Array.from(Pcm.s16leToF32(Pcm.f32leToS16le(floats)))).toEqual([0.4999847412109375, -0.5])
  })

  it.effect("carries bytes short of a sample into the next chunk", () =>
    Effect.gen(function* () {
      const chunks = yield* Stream.make(
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4]),
        new Uint8Array([5]),
      ).pipe(Pcm.wholeSamples(2), Stream.runCollect)
      expect(chunks.map((c) => Array.from(c))).toEqual([
        [1, 2],
        [3, 4],
      ])
    }),
  )
})
