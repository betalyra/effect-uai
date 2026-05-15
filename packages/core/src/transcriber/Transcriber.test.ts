import { Effect, Stream } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AiError from "../domain/AiError.js"
import type { TranscriptEvent, TranscriptResult } from "../domain/Transcript.js"
import * as MockTranscriber from "../testing/MockTranscriber.js"
import * as Transcriber from "./Transcriber.js"

describe("Transcriber.transcribe", () => {
  it("returns the scripted TranscriptResult", async () => {
    const mock = MockTranscriber.layer({
      transcripts: [{ text: "hello world", durationSeconds: 1.23 }],
    })
    const program = Transcriber.transcribe({
      audio: { _tag: "bytes", bytes: new Uint8Array([0]), mimeType: "audio/wav" },
      model: "mock-stt",
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(result.text).toBe("hello world")
    expect(result.durationSeconds).toBe(1.23)
  })

  it("records each transcribe call", async () => {
    const mock = MockTranscriber.layer({
      transcripts: [{ text: "a" }, { text: "b" }],
    })
    const program = Effect.gen(function* () {
      yield* Transcriber.transcribe({
        audio: { _tag: "bytes", bytes: new Uint8Array([1]), mimeType: "audio/wav" },
        model: "m1",
      })
      yield* Transcriber.transcribe({
        audio: { _tag: "bytes", bytes: new Uint8Array([2]), mimeType: "audio/wav" },
        model: "m2",
      })
      return yield* mock.recorder
    })
    const rec = await Effect.runPromise(program.pipe(Effect.provide(mock.layer)))
    expect(rec.transcribeCalls.map((c) => c.model)).toEqual(["m1", "m2"])
  })
})

describe("Transcriber capability marker (compile-time)", () => {
  const sttReq: Transcriber.CommonStreamTranscribeRequest = {
    model: "mock-stt",
    inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000 },
  }

  it("requires `SttStreaming` on the R channel of streamTranscriptionFrom", () => {
    const audio: Stream.Stream<Uint8Array> = Stream.fromIterable([new Uint8Array([0])])
    const events = audio.pipe(Transcriber.streamTranscriptionFrom(sttReq))
    expectTypeOf(events).toEqualTypeOf<
      Stream.Stream<
        TranscriptEvent,
        AiError.AiError,
        Transcriber.Transcriber | Transcriber.SttStreaming
      >
    >()
  })

  it("does NOT require `SttStreaming` for sync `transcribe`", () => {
    const eff = Transcriber.transcribe({
      audio: { _tag: "bytes", bytes: new Uint8Array([0]), mimeType: "audio/wav" },
      model: "m",
    })
    expectTypeOf(eff).toEqualTypeOf<
      Effect.Effect<TranscriptResult, AiError.AiError, Transcriber.Transcriber>
    >()
  })

  it("a sync-only layer leaves `SttStreaming` unsatisfied in R", () => {
    const syncOnly = MockTranscriber.layerSyncOnly({})
    const audio: Stream.Stream<Uint8Array> = Stream.fromIterable([new Uint8Array([0])])
    const events = audio.pipe(Transcriber.streamTranscriptionFrom(sttReq))
    const program = Stream.runDrain(events).pipe(Effect.provide(syncOnly.layer))
    // `Transcriber` is provided by syncOnly.layer; `SttStreaming` is not.
    expectTypeOf(program).toEqualTypeOf<
      Effect.Effect<void, AiError.AiError, Transcriber.SttStreaming>
    >()
  })

  it("a full layer (with marker) clears R to never", () => {
    const fullMock = MockTranscriber.layer({ streams: [[]] })
    const audio: Stream.Stream<Uint8Array> = Stream.fromIterable([new Uint8Array([0])])
    const events = audio.pipe(Transcriber.streamTranscriptionFrom(sttReq))
    const program = Stream.runDrain(events).pipe(Effect.provide(fullMock.layer))
    expectTypeOf(program).toEqualTypeOf<Effect.Effect<void, AiError.AiError, never>>()
  })
})

describe("Transcriber.streamTranscriptionFrom", () => {
  const sttReq: Transcriber.CommonStreamTranscribeRequest = {
    model: "mock-stt",
    inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000 },
  }

  it("emits scripted events after draining the input audio stream", async () => {
    const mock = MockTranscriber.layer({
      streams: [
        [
          { _tag: "partial", text: "hello" },
          { _tag: "final", text: "hello world" },
        ],
      ],
    })
    const audio = Stream.fromIterable([new Uint8Array([0, 1, 2]), new Uint8Array([3, 4, 5])])
    const events = audio.pipe(Transcriber.streamTranscriptionFrom(sttReq))
    const collected = await Effect.runPromise(
      Stream.runCollect(events).pipe(Effect.provide(mock.layer)),
    )
    expect(collected).toEqual([
      { _tag: "partial", text: "hello" },
      { _tag: "final", text: "hello world" },
    ])
  })

  it("works data-first (direct call) as well as pipeable (data-last)", async () => {
    const mock = MockTranscriber.layer({
      streams: [[{ _tag: "final", text: "x" }]],
    })
    const audio = Stream.fromIterable([new Uint8Array([0])])
    const events = Transcriber.streamTranscriptionFrom(audio, sttReq)
    const out = await Effect.runPromise(Stream.runCollect(events).pipe(Effect.provide(mock.layer)))
    expect(out).toEqual([{ _tag: "final", text: "x" }])
  })
})
