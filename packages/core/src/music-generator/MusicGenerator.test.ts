import { Effect, Stream } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "../domain/AiError.js"
import type { AudioChunk, AudioFormat } from "../domain/Audio.js"
import {
  configInput,
  promptsInput,
  type MusicResult,
} from "../domain/Music.js"
import * as MockMusicGenerator from "../testing/MockMusicGenerator.js"
import * as MusicGenerator from "./MusicGenerator.js"

const mp3Format: AudioFormat = {
  container: "mp3",
  encoding: "mp3",
  sampleRate: 44100,
  channels: 2,
}

const result: MusicResult = {
  format: mp3Format,
  bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x00]),
  durationSeconds: 30,
  lyrics: "[Verse]\nhello\n",
  watermark: { kind: "synthid" },
}

const chunk = (n: number): AudioChunk => ({ bytes: new Uint8Array([n]) })

describe("MusicGenerator.generate", () => {
  it("returns the scripted MusicResult", async () => {
    const mock = MockMusicGenerator.layer({ results: [result] })
    const program = MusicGenerator.generate({
      model: "mock-music",
      prompts: "upbeat indie pop",
    })
    const out = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(out.bytes).toEqual(result.bytes)
    expect(out.durationSeconds).toBe(30)
    expect(out.watermark?.kind).toBe("synthid")
    expect(out.lyrics).toContain("[Verse]")
  })

  it("records the request shape on the recorder", async () => {
    const mock = MockMusicGenerator.layer({ results: [result, result] })
    const program = Effect.gen(function* () {
      yield* MusicGenerator.generate({ model: "m", prompts: "techno" })
      yield* MusicGenerator.generate({
        model: "m",
        prompts: [
          { text: "synthwave", weight: 1.0 },
          { text: "80s movie OST", weight: 0.4 },
        ],
        bpm: 120,
        instrumental: true,
      })
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.generateCalls.length).toBe(2)
    expect(rec.generateCalls[1]!.bpm).toBe(120)
    expect(rec.generateCalls[1]!.instrumental).toBe(true)
    expect(Array.isArray(rec.generateCalls[1]!.prompts)).toBe(true)
  })
})

describe("MusicGenerator.streamGeneration", () => {
  it("emits scripted chunks", async () => {
    const mock = MockMusicGenerator.layer({
      streamGenerationChunks: [[chunk(1), chunk(2), chunk(3)]],
    })
    const program = Stream.runCollect(
      MusicGenerator.streamGeneration({ model: "m", prompts: "ambient" }),
    )
    const out = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(out.map((c) => Array.from(c.bytes))).toEqual([[1], [2], [3]])
  })
})

describe("MusicGenerator capability marker (compile-time)", () => {
  const sgfReq: MusicGenerator.CommonStreamGenerateMusicRequest = {
    model: "m",
    prompts: "",
  }

  it("requires `MusicInteractiveSession` on the R channel of streamGenerationFrom", () => {
    const inputs = Stream.fromIterable([promptsInput([{ text: "techno" }])])
    const audio = inputs.pipe(MusicGenerator.streamGenerationFrom(sgfReq))
    expectTypeOf(audio).toEqualTypeOf<
      Stream.Stream<
        AudioChunk,
        AiError.AiError,
        MusicGenerator.MusicGenerator | MusicGenerator.MusicInteractiveSession
      >
    >()
  })

  it("does NOT require `MusicInteractiveSession` for sync `generate`", () => {
    const eff = MusicGenerator.generate({ model: "m", prompts: "ambient" })
    expectTypeOf(eff).toEqualTypeOf<
      Effect.Effect<MusicResult, AiError.AiError, MusicGenerator.MusicGenerator>
    >()
  })

  it("does NOT require `MusicInteractiveSession` for `streamGeneration`", () => {
    const audio = MusicGenerator.streamGeneration({ model: "m", prompts: "ambient" })
    expectTypeOf(audio).toEqualTypeOf<
      Stream.Stream<AudioChunk, AiError.AiError, MusicGenerator.MusicGenerator>
    >()
  })

  it("a layer without the marker leaves `MusicInteractiveSession` unsatisfied in R", () => {
    const noMarker = MockMusicGenerator.layerWithoutInteractive({})
    const inputs = Stream.fromIterable([promptsInput([{ text: "techno" }])])
    const audio = inputs.pipe(MusicGenerator.streamGenerationFrom(sgfReq))
    const program = Stream.runDrain(audio).pipe(Effect.provide(noMarker.layer))
    expectTypeOf(program).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, MusicGenerator.MusicInteractiveSession>
    >()
  })

  it("a full layer (with marker) clears R to never", () => {
    const fullMock = MockMusicGenerator.layer({
      streamGenerationFromChunks: [[]],
    })
    const inputs = Stream.fromIterable([promptsInput([{ text: "techno" }])])
    const audio = inputs.pipe(MusicGenerator.streamGenerationFrom(sgfReq))
    const program = Stream.runDrain(audio).pipe(Effect.provide(fullMock.layer))
    expectTypeOf(program).toEqualTypeOf<Effect.Effect<void, AiError.AiError, never>>()
  })
})

describe("MusicGenerator.streamGenerationFrom", () => {
  const sgfReq: MusicGenerator.CommonStreamGenerateMusicRequest = {
    model: "lyria-realtime-001",
    prompts: "",
  }

  it("drains a session-input stream and emits scripted audio", async () => {
    const mock = MockMusicGenerator.layer({
      streamGenerationFromChunks: [[chunk(10), chunk(20)]],
    })
    const inputs = Stream.fromIterable([
      promptsInput([{ text: "minimal techno", weight: 1.0 }]),
      configInput({ bpm: 124 }),
      promptsInput([
        { text: "minimal techno", weight: 1.0 },
        { text: "1980s synthwave", weight: 0.3 },
      ]),
    ])
    const audio = inputs.pipe(MusicGenerator.streamGenerationFrom(sgfReq))
    const out = await Effect.runPromise(
      Stream.runCollect(audio).pipe(Effect.provide(mock.layer)),
    )
    expect(out.map((c) => Array.from(c.bytes))).toEqual([[10], [20]])
  })

  it("records the request on the streamGenerationFrom call channel", async () => {
    const mock = MockMusicGenerator.layer({
      streamGenerationFromChunks: [[chunk(42)]],
    })
    const program = Effect.gen(function* () {
      yield* Stream.runDrain(
        Stream.fromIterable([promptsInput([{ text: "x" }])]).pipe(
          MusicGenerator.streamGenerationFrom(sgfReq),
        ),
      )
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.streamGenerationFromCalls.length).toBe(1)
    expect(rec.streamGenerationFromCalls[0]!.model).toBe("lyria-realtime-001")
    expect(rec.generateCalls.length).toBe(0)
    expect(rec.streamGenerationCalls.length).toBe(0)
  })
})
