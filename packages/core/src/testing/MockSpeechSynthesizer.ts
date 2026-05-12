import { Effect, Layer, Ref, Stream } from "effect"
import type { AudioBlob, AudioChunk } from "../domain/Audio.js"
import * as AiError from "../domain/AiError.js"
import {
  SpeechSynthesizer,
  TtsIncrementalText,
  type CommonStreamSynthesizeRequest,
  type CommonSynthesizeRequest,
  type SpeechSynthesizerService,
} from "../speech-synthesizer/SpeechSynthesizer.js"

export type MockSynthesizerRecorder = {
  readonly synthesizeCalls: ReadonlyArray<CommonSynthesizeRequest>
  readonly streamSynthesisCalls: ReadonlyArray<CommonSynthesizeRequest>
  readonly streamSynthesisFromCalls: ReadonlyArray<CommonStreamSynthesizeRequest>
}

export type MockSynthesizerScript = {
  /** One blob per `synthesize` call, consumed in order. */
  readonly blobs?: ReadonlyArray<AudioBlob>
  /** One chunk-list per `streamSynthesis` call, consumed in order. */
  readonly streamSynthesisChunks?: ReadonlyArray<ReadonlyArray<AudioChunk>>
  /** One chunk-list per `streamSynthesisFrom` call, consumed in order. */
  readonly streamSynthesisFromChunks?: ReadonlyArray<ReadonlyArray<AudioChunk>>
}

const makeService = (
  script: MockSynthesizerScript,
  record: {
    readonly synthesize: (req: CommonSynthesizeRequest) => Effect.Effect<void>
    readonly streamSynthesis: (req: CommonSynthesizeRequest) => Effect.Effect<void>
    readonly streamSynthesisFrom: (req: CommonStreamSynthesizeRequest) => Effect.Effect<void>
  },
) =>
  Effect.gen(function* () {
    const bCursor = yield* Ref.make(0)
    const ssCursor = yield* Ref.make(0)
    const ssfCursor = yield* Ref.make(0)
    const service: SpeechSynthesizerService = {
      synthesize: (request) =>
        Effect.gen(function* () {
          yield* record.synthesize(request)
          const i = yield* Ref.getAndUpdate(bCursor, (n) => n + 1)
          const scripted = script.blobs ?? []
          if (i >= scripted.length) {
            return yield* Effect.fail(
              new AiError.InvalidRequest({
                provider: "mock",
                raw: `MockSpeechSynthesizer exhausted: ${scripted.length} blobs scripted, but call ${i + 1} was made`,
              }),
            )
          }
          return scripted[i]!
        }),
      streamSynthesis: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* record.streamSynthesis(request)
            const i = yield* Ref.getAndUpdate(ssCursor, (n) => n + 1)
            const scripted = script.streamSynthesisChunks ?? []
            if (i >= scripted.length) {
              return Stream.fail(
                new AiError.InvalidRequest({
                  provider: "mock",
                  raw: `MockSpeechSynthesizer exhausted: ${scripted.length} streamSynthesis lists scripted, but call ${i + 1} was made`,
                }),
              )
            }
            return Stream.fromIterable(scripted[i]!)
          }),
        ),
      streamSynthesisFrom: <E, R>(
        textIn: Stream.Stream<string, E, R>,
        request: CommonStreamSynthesizeRequest,
      ): Stream.Stream<AudioChunk, AiError.AiError | E, R> =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* record.streamSynthesisFrom(request)
            const i = yield* Ref.getAndUpdate(ssfCursor, (n) => n + 1)
            const scripted = script.streamSynthesisFromChunks ?? []
            if (i >= scripted.length) {
              const exhausted: Stream.Stream<AudioChunk, AiError.AiError | E, R> = Stream.fail(
                new AiError.InvalidRequest({
                  provider: "mock",
                  raw: `MockSpeechSynthesizer exhausted: ${scripted.length} streamSynthesisFrom lists scripted, but call ${i + 1} was made`,
                }),
              )
              return exhausted
            }
            // Drain the input text fully before emitting scripted audio chunks,
            // so consumers can assert on what text was pushed.
            return Stream.drain(textIn).pipe(Stream.concat(Stream.fromIterable(scripted[i]!)))
          }),
        ),
    }
    return service
  })

/**
 * Layer providing the `SpeechSynthesizer` service AND the
 * `TtsIncrementalText` capability marker. Use for the common case
 * where code under test exercises `streamSynthesisFrom`.
 */
export const layer = (
  script: MockSynthesizerScript,
): {
  readonly layer: Layer.Layer<SpeechSynthesizer | TtsIncrementalText>
  readonly recorder: Effect.Effect<MockSynthesizerRecorder>
} => {
  const bCalls = Ref.makeUnsafe<ReadonlyArray<CommonSynthesizeRequest>>([])
  const ssCalls = Ref.makeUnsafe<ReadonlyArray<CommonSynthesizeRequest>>([])
  const ssfCalls = Ref.makeUnsafe<ReadonlyArray<CommonStreamSynthesizeRequest>>([])
  const synthesizerLayer = Layer.effect(
    SpeechSynthesizer,
    makeService(script, {
      synthesize: (req) => Ref.update(bCalls, (xs) => [...xs, req]),
      streamSynthesis: (req) => Ref.update(ssCalls, (xs) => [...xs, req]),
      streamSynthesisFrom: (req) => Ref.update(ssfCalls, (xs) => [...xs, req]),
    }),
  )
  const live = Layer.merge(synthesizerLayer, Layer.succeed(TtsIncrementalText, undefined))
  return {
    layer: live,
    recorder: Effect.gen(function* () {
      const synthesizeCalls = yield* Ref.get(bCalls)
      const streamSynthesisCalls = yield* Ref.get(ssCalls)
      const streamSynthesisFromCalls = yield* Ref.get(ssfCalls)
      return { synthesizeCalls, streamSynthesisCalls, streamSynthesisFromCalls }
    }),
  }
}

/**
 * Variant that omits the `TtsIncrementalText` marker — simulates a
 * provider without incremental-text-in support (e.g. OpenAI, AWS
 * Polly non-Generative). Calls to `streamSynthesisFrom` in code under
 * test should be a compile-time error.
 */
export const layerWithoutIncremental = (
  script: MockSynthesizerScript,
): {
  readonly layer: Layer.Layer<SpeechSynthesizer>
  readonly recorder: Effect.Effect<MockSynthesizerRecorder>
} => {
  const bCalls = Ref.makeUnsafe<ReadonlyArray<CommonSynthesizeRequest>>([])
  const ssCalls = Ref.makeUnsafe<ReadonlyArray<CommonSynthesizeRequest>>([])
  const ssfCalls = Ref.makeUnsafe<ReadonlyArray<CommonStreamSynthesizeRequest>>([])
  const live = Layer.effect(
    SpeechSynthesizer,
    makeService(script, {
      synthesize: (req) => Ref.update(bCalls, (xs) => [...xs, req]),
      streamSynthesis: (req) => Ref.update(ssCalls, (xs) => [...xs, req]),
      streamSynthesisFrom: (req) => Ref.update(ssfCalls, (xs) => [...xs, req]),
    }),
  )
  return {
    layer: live,
    recorder: Effect.gen(function* () {
      const synthesizeCalls = yield* Ref.get(bCalls)
      const streamSynthesisCalls = yield* Ref.get(ssCalls)
      const streamSynthesisFromCalls = yield* Ref.get(ssfCalls)
      return { synthesizeCalls, streamSynthesisCalls, streamSynthesisFromCalls }
    }),
  }
}
