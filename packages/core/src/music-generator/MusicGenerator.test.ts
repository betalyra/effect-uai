import { Duration, Effect, Stream } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "../domain/AiError.js"
import type { AudioChunk, AudioFormat } from "../domain/Audio.js"
import {
  audioEvent,
  controlInput,
  type GenerateResult,
  type MusicResult,
  type MusicStreamEvent,
  promptsInput,
  singleVariant,
} from "../domain/Music.js"
import * as MockMusicGenerator from "../testing/MockMusicGenerator.js"
import * as MusicGenerator from "./MusicGenerator.js"

const mp3Format: AudioFormat = {
  container: "mp3",
  encoding: "mp3",
  sampleRate: 44100,
  channels: 2,
}

const oneResult: MusicResult = {
  audio: {
    format: mp3Format,
    bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x00]),
    duration: Duration.seconds(30),
  },
  provider: "mock-music",
  lyrics: "[Verse]\nhello\n",
  watermark: "synthid",
}

const oneVariant: GenerateResult = singleVariant(oneResult)

const chunk = (n: number): AudioChunk => ({ bytes: new Uint8Array([n]) })

describe("MusicGenerator.generate", () => {
  it("returns the scripted GenerateResult", async () => {
    const mock = MockMusicGenerator.layer({ results: [oneVariant] })
    const program = MusicGenerator.generate({
      model: "mock-music",
      prompt: "upbeat indie pop",
    })
    const out = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(out.primary.audio.bytes).toEqual(oneResult.audio.bytes)
    expect(out.primary.audio.duration).toEqual(Duration.seconds(30))
    expect(out.primary.watermark).toBe("synthid")
    expect(out.primary.lyrics).toContain("[Verse]")
    expect(out.variants).toHaveLength(1)
    expect(out.variants[0]).toBe(out.primary)
  })

  it("exposes multiple variants when the provider returned more than one", async () => {
    const secondTrack: MusicResult = {
      ...oneResult,
      audio: { ...oneResult.audio, bytes: new Uint8Array([0xff, 0xfb, 0xa0, 0x00]) },
    }
    const twoVariants: GenerateResult = {
      primary: oneResult,
      variants: [oneResult, secondTrack],
    }
    const mock = MockMusicGenerator.layer({ results: [twoVariants] })
    const program = MusicGenerator.generate({ model: "m", prompt: "house" })
    const out = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(out.variants).toHaveLength(2)
    expect(out.variants[1]!.audio.bytes).toEqual(secondTrack.audio.bytes)
  })

  it("records the request shape on the recorder", async () => {
    const mock = MockMusicGenerator.layer({ results: [oneVariant, oneVariant] })
    const program = Effect.gen(function* () {
      yield* MusicGenerator.generate({ model: "m", prompt: "techno" })
      yield* MusicGenerator.generate({
        model: "m",
        prompt: "synthwave",
        duration: Duration.seconds(45),
        seed: 42,
      })
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.generateCalls.length).toBe(2)
    expect(rec.generateCalls[1]!.duration).toEqual(Duration.seconds(45))
    expect(rec.generateCalls[1]!.seed).toBe(42)
  })
})

describe("MusicGenerator.streamGeneration", () => {
  it("emits scripted chunks", async () => {
    const mock = MockMusicGenerator.layer({
      streamGenerationChunks: [[chunk(1), chunk(2), chunk(3)]],
    })
    const program = Stream.runCollect(
      MusicGenerator.streamGeneration({ model: "m", prompt: "ambient" }),
    )
    const out = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(out.map((c) => Array.from(c.bytes))).toEqual([[1], [2], [3]])
  })
})

describe("MusicGenerator capability marker (compile-time)", () => {
  const sgfReq: MusicGenerator.CommonStreamGenerateMusicRequest = {
    model: "m",
    prompt: "",
  }

  it("requires `MusicInteractiveSession` on the R channel of streamGenerationFrom", () => {
    const inputs = Stream.fromIterable([promptsInput([{ text: "techno" }])])
    const events = inputs.pipe(MusicGenerator.streamGenerationFrom(sgfReq))
    expectTypeOf(events).toEqualTypeOf<
      Stream.Stream<
        MusicStreamEvent,
        AiError.AiError,
        MusicGenerator.MusicGenerator | MusicGenerator.MusicInteractiveSession
      >
    >()
  })

  it("does NOT require `MusicInteractiveSession` for sync `generate`", () => {
    const eff = MusicGenerator.generate({ model: "m", prompt: "ambient" })
    expectTypeOf(eff).toEqualTypeOf<
      Effect.Effect<GenerateResult, AiError.AiError, MusicGenerator.MusicGenerator>
    >()
  })

  it("does NOT require `MusicInteractiveSession` for `streamGeneration`", () => {
    const audio = MusicGenerator.streamGeneration({ model: "m", prompt: "ambient" })
    expectTypeOf(audio).toEqualTypeOf<
      Stream.Stream<AudioChunk, AiError.AiError, MusicGenerator.MusicGenerator>
    >()
  })

  it("a layer without the marker leaves `MusicInteractiveSession` unsatisfied in R", () => {
    const noMarker = MockMusicGenerator.layerWithoutInteractive({})
    const inputs = Stream.fromIterable([promptsInput([{ text: "techno" }])])
    const events = inputs.pipe(MusicGenerator.streamGenerationFrom(sgfReq))
    const program = Stream.runDrain(events).pipe(Effect.provide(noMarker.layer))
    expectTypeOf(program).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, MusicGenerator.MusicInteractiveSession>
    >()
  })

  it("a full layer (with marker) clears R to never", () => {
    const fullMock = MockMusicGenerator.layer({
      streamGenerationFromEvents: [[]],
    })
    const inputs = Stream.fromIterable([promptsInput([{ text: "techno" }])])
    const events = inputs.pipe(MusicGenerator.streamGenerationFrom(sgfReq))
    const program = Stream.runDrain(events).pipe(Effect.provide(fullMock.layer))
    expectTypeOf(program).toEqualTypeOf<Effect.Effect<void, AiError.AiError, never>>()
  })
})

describe("MusicGenerator.streamGenerationFrom", () => {
  const sgfReq: MusicGenerator.CommonStreamGenerateMusicRequest = {
    model: "lyria-realtime-exp",
    prompt: "",
  }

  it("drains a session-input stream and emits scripted events", async () => {
    const mock = MockMusicGenerator.layer({
      streamGenerationFromEvents: [[audioEvent(chunk(10)), audioEvent(chunk(20))]],
    })
    const inputs = Stream.fromIterable([
      promptsInput([{ text: "minimal techno", weight: 1.0 }]),
      controlInput("play"),
      promptsInput([
        { text: "minimal techno", weight: 1.0 },
        { text: "1980s synthwave", weight: 0.3 },
      ]),
    ])
    const events = inputs.pipe(MusicGenerator.streamGenerationFrom(sgfReq))
    const out = await Effect.runPromise(
      Stream.runCollect(events).pipe(Effect.provide(mock.layer)),
    )
    const audioChunks = out.flatMap((e) => (e._tag === "audio" ? [e.chunk] : []))
    expect(audioChunks.map((c) => Array.from(c.bytes))).toEqual([[10], [20]])
  })

  it("records the request on the streamGenerationFrom call channel", async () => {
    const mock = MockMusicGenerator.layer({
      streamGenerationFromEvents: [[audioEvent(chunk(42))]],
    })
    const program = Effect.gen(function* () {
      const inputs = Stream.fromIterable([promptsInput([{ text: "x" }])])
      yield* Stream.runDrain(inputs.pipe(MusicGenerator.streamGenerationFrom(sgfReq)))
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.streamGenerationFromCalls.length).toBe(1)
    expect(rec.streamGenerationFromCalls[0]!.model).toBe("lyria-realtime-exp")
    expect(rec.generateCalls.length).toBe(0)
    expect(rec.streamGenerationCalls.length).toBe(0)
  })
})
