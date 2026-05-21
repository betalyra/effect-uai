import { Effect, Stream } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "../domain/AiError.js"
import type { AudioBlob, AudioChunk, AudioFormat } from "../domain/Audio.js"
import * as MockSpeechSynthesizer from "../testing/MockSpeechSynthesizer.js"
import * as SpeechSynthesizer from "./SpeechSynthesizer.js"

const pcmFormat: AudioFormat = {
  container: "raw",
  encoding: "pcm_s16le",
  sampleRate: 24000,
}

const blob: AudioBlob = {
  format: pcmFormat,
  bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  durationSeconds: 0.5,
}

const chunk = (n: number): AudioChunk => ({ bytes: new Uint8Array([n]) })

describe("SpeechSynthesizer.synthesize", () => {
  it("returns the scripted AudioBlob", async () => {
    const mock = MockSpeechSynthesizer.layer({ blobs: [blob] })
    const program = SpeechSynthesizer.synthesize({
      text: "hi",
      model: "mock-tts",
      voiceId: "stock-voice",
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(result.bytes).toEqual(blob.bytes)
    expect(result.durationSeconds).toBe(0.5)
  })
})

describe("SpeechSynthesizer.streamSynthesis", () => {
  it("emits scripted chunks for full-text-in streaming", async () => {
    const mock = MockSpeechSynthesizer.layer({
      streamSynthesisChunks: [[chunk(1), chunk(2), chunk(3)]],
    })
    const program = Stream.runCollect(
      SpeechSynthesizer.streamSynthesis({
        text: "hi",
        model: "mock-tts",
        voiceId: "stock-voice",
      }),
    )
    const out = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(out.map((c) => Array.from(c.bytes))).toEqual([[1], [2], [3]])
  })
})

describe("SpeechSynthesizer capability marker (compile-time)", () => {
  const ssfReq: SpeechSynthesizer.CommonStreamSynthesizeRequest = {
    model: "mock-tts",
    voiceId: "v",
  }

  it("requires `TtsIncrementalText` on the R channel of streamSynthesisFrom", () => {
    const tokens: Stream.Stream<string> = Stream.fromIterable(["a"])
    const audio = tokens.pipe(SpeechSynthesizer.streamSynthesisFrom(ssfReq))
    expectTypeOf(audio).toEqualTypeOf<
      Stream.Stream<
        AudioChunk,
        AiError.AiError,
        SpeechSynthesizer.SpeechSynthesizer | SpeechSynthesizer.TtsIncrementalText
      >
    >()
  })

  it("does NOT require `TtsIncrementalText` for sync `synthesize`", () => {
    const eff = SpeechSynthesizer.synthesize({ text: "hi", model: "m", voiceId: "v" })
    expectTypeOf(eff).toEqualTypeOf<
      Effect.Effect<AudioBlob, AiError.AiError, SpeechSynthesizer.SpeechSynthesizer>
    >()
  })

  it("does NOT require `TtsIncrementalText` for full-text `streamSynthesis`", () => {
    const audio = SpeechSynthesizer.streamSynthesis({ text: "hi", model: "m", voiceId: "v" })
    expectTypeOf(audio).toEqualTypeOf<
      Stream.Stream<AudioChunk, AiError.AiError, SpeechSynthesizer.SpeechSynthesizer>
    >()
  })

  it("a layer without the marker leaves `TtsIncrementalText` unsatisfied in R", () => {
    const noMarker = MockSpeechSynthesizer.layerWithoutIncremental({})
    const tokens: Stream.Stream<string> = Stream.fromIterable(["a"])
    const audio = tokens.pipe(SpeechSynthesizer.streamSynthesisFrom(ssfReq))
    const program = Stream.runDrain(audio).pipe(Effect.provide(noMarker.layer))
    // `SpeechSynthesizer` is provided by the layer; `TtsIncrementalText` is not,
    // so it remains in R — calling `Effect.runPromise(program)` would be a type
    // error because runPromise requires `R = never`.
    expectTypeOf(program).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, SpeechSynthesizer.TtsIncrementalText>
    >()
  })

  it("a full layer (with marker) clears R to never", () => {
    const fullMock = MockSpeechSynthesizer.layer({
      streamSynthesisFromChunks: [[]],
    })
    const tokens: Stream.Stream<string> = Stream.fromIterable(["a"])
    const audio = tokens.pipe(SpeechSynthesizer.streamSynthesisFrom(ssfReq))
    const program = Stream.runDrain(audio).pipe(Effect.provide(fullMock.layer))
    expectTypeOf(program).toEqualTypeOf<Effect.Effect<void, AiError.AiError, never>>()
  })
})

describe("SpeechSynthesizer.synthesizeDialogue", () => {
  const dialogueReq: SpeechSynthesizer.CommonSynthesizeDialogueRequest = {
    model: "mock-tts",
    turns: [
      { voiceId: "voice-a", text: "Hi" },
      { voiceId: "voice-b", text: "Hello" },
    ],
  }

  it("returns the scripted AudioBlob", async () => {
    const mock = MockSpeechSynthesizer.layer({ dialogueBlobs: [blob] })
    const result = await Effect.runPromise(
      SpeechSynthesizer.synthesizeDialogue(dialogueReq).pipe(Effect.provide(mock.layer)),
    )
    expect(result.bytes).toEqual(blob.bytes)
  })

  it("records the request on the synthesizeDialogue call channel", async () => {
    const mock = MockSpeechSynthesizer.layer({ dialogueBlobs: [blob] })
    const program = Effect.gen(function* () {
      yield* SpeechSynthesizer.synthesizeDialogue(dialogueReq)
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.synthesizeDialogueCalls.length).toBe(1)
    expect(rec.synthesizeDialogueCalls[0]!.turns.length).toBe(2)
    expect(rec.synthesizeCalls.length).toBe(0)
  })

  it("emits scripted chunks for streamSynthesizeDialogue", async () => {
    const mock = MockSpeechSynthesizer.layer({
      streamSynthesizeDialogueChunks: [[chunk(7), chunk(8)]],
    })
    const out = await Effect.runPromise(
      Stream.runCollect(SpeechSynthesizer.streamSynthesizeDialogue(dialogueReq)).pipe(
        Effect.provide(mock.layer),
      ),
    )
    expect(out.map((c) => Array.from(c.bytes))).toEqual([[7], [8]])
  })
})

describe("MultiSpeakerTts capability marker (compile-time)", () => {
  const dialogueReq: SpeechSynthesizer.CommonSynthesizeDialogueRequest = {
    model: "mock-tts",
    turns: [{ voiceId: "a", text: "Hi" }],
  }

  it("requires `MultiSpeakerTts` on the R channel of synthesizeDialogue", () => {
    const eff = SpeechSynthesizer.synthesizeDialogue(dialogueReq)
    expectTypeOf(eff).toEqualTypeOf<
      Effect.Effect<
        AudioBlob,
        AiError.AiError,
        SpeechSynthesizer.SpeechSynthesizer | SpeechSynthesizer.MultiSpeakerTts
      >
    >()
  })

  it("requires `MultiSpeakerTts` on the R channel of streamSynthesizeDialogue", () => {
    const s = SpeechSynthesizer.streamSynthesizeDialogue(dialogueReq)
    expectTypeOf(s).toEqualTypeOf<
      Stream.Stream<
        AudioChunk,
        AiError.AiError,
        SpeechSynthesizer.SpeechSynthesizer | SpeechSynthesizer.MultiSpeakerTts
      >
    >()
  })

  it("a layer without the marker leaves `MultiSpeakerTts` unsatisfied in R", () => {
    const noMarker = MockSpeechSynthesizer.layerWithoutMultiSpeaker({})
    const program = SpeechSynthesizer.synthesizeDialogue(dialogueReq).pipe(
      Effect.provide(noMarker.layer),
    )
    expectTypeOf(program).toEqualTypeOf<
      Effect.Effect<AudioBlob, AiError.AiError, SpeechSynthesizer.MultiSpeakerTts>
    >()
  })

  it("a full layer (with marker) clears R to never", () => {
    const fullMock = MockSpeechSynthesizer.layer({ dialogueBlobs: [blob] })
    const program = SpeechSynthesizer.synthesizeDialogue(dialogueReq).pipe(
      Effect.provide(fullMock.layer),
    )
    expectTypeOf(program).toEqualTypeOf<Effect.Effect<AudioBlob, AiError.AiError, never>>()
  })
})

describe("SpeechSynthesizer.streamSynthesisFrom", () => {
  const ssfReq: SpeechSynthesizer.CommonStreamSynthesizeRequest = {
    model: "mock-tts",
    voiceId: "stock-voice",
  }

  it("pipes an LLM-style text stream into audio chunks", async () => {
    const mock = MockSpeechSynthesizer.layer({
      streamSynthesisFromChunks: [[chunk(10), chunk(20)]],
    })
    const tokens = Stream.fromIterable(["Hello, ", "world."])
    const audio = tokens.pipe(SpeechSynthesizer.streamSynthesisFrom(ssfReq))
    const out = await Effect.runPromise(Stream.runCollect(audio).pipe(Effect.provide(mock.layer)))
    expect(out.map((c) => Array.from(c.bytes))).toEqual([[10], [20]])
  })

  it("records the request on the streamSynthesisFrom call channel", async () => {
    const mock = MockSpeechSynthesizer.layer({
      streamSynthesisFromChunks: [[chunk(42)]],
    })
    const program = Effect.gen(function* () {
      yield* Stream.runDrain(
        Stream.fromIterable(["x"]).pipe(SpeechSynthesizer.streamSynthesisFrom(ssfReq)),
      )
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.streamSynthesisFromCalls.length).toBe(1)
    expect(rec.streamSynthesisFromCalls[0]!.voiceId).toBe("stock-voice")
    expect(rec.synthesizeCalls.length).toBe(0)
    expect(rec.streamSynthesisCalls.length).toBe(0)
  })
})
