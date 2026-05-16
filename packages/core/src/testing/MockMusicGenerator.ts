import { Effect, Layer, Ref, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { AudioChunk } from "../domain/Audio.js"
import type {
  CommonGenerateMusicRequest,
  CommonStreamGenerateMusicRequest,
  MusicResult,
  MusicSessionInput,
} from "../domain/Music.js"
import {
  MusicGenerator,
  MusicInteractiveSession,
  type MusicGeneratorService,
} from "../music-generator/MusicGenerator.js"

export type MockMusicGeneratorRecorder = {
  readonly generateCalls: ReadonlyArray<CommonGenerateMusicRequest>
  readonly streamGenerationCalls: ReadonlyArray<CommonStreamGenerateMusicRequest>
  readonly streamGenerationFromCalls: ReadonlyArray<CommonStreamGenerateMusicRequest>
}

export type MockMusicGeneratorScript = {
  /** One result per `generate` call, consumed in order. */
  readonly results?: ReadonlyArray<MusicResult>
  /** One chunk-list per `streamGeneration` call, consumed in order. */
  readonly streamGenerationChunks?: ReadonlyArray<ReadonlyArray<AudioChunk>>
  /** One chunk-list per `streamGenerationFrom` call, consumed in order. */
  readonly streamGenerationFromChunks?: ReadonlyArray<ReadonlyArray<AudioChunk>>
}

const makeService = (
  script: MockMusicGeneratorScript,
  record: {
    readonly generate: (req: CommonGenerateMusicRequest) => Effect.Effect<void>
    readonly streamGeneration: (req: CommonStreamGenerateMusicRequest) => Effect.Effect<void>
    readonly streamGenerationFrom: (req: CommonStreamGenerateMusicRequest) => Effect.Effect<void>
  },
) =>
  Effect.gen(function* () {
    const gCursor = yield* Ref.make(0)
    const sgCursor = yield* Ref.make(0)
    const sgfCursor = yield* Ref.make(0)
    const service: MusicGeneratorService = {
      generate: (request) =>
        Effect.gen(function* () {
          yield* record.generate(request)
          const i = yield* Ref.getAndUpdate(gCursor, (n) => n + 1)
          const scripted = script.results ?? []
          if (i >= scripted.length) {
            return yield* new AiError.InvalidRequest({
              provider: "mock",
              raw: `MockMusicGenerator exhausted: ${scripted.length} results scripted, but call ${i + 1} was made`,
            })
          }
          return scripted[i]!
        }),
      streamGeneration: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* record.streamGeneration(request)
            const i = yield* Ref.getAndUpdate(sgCursor, (n) => n + 1)
            const scripted = script.streamGenerationChunks ?? []
            if (i >= scripted.length) {
              return Stream.fail(
                new AiError.InvalidRequest({
                  provider: "mock",
                  raw: `MockMusicGenerator exhausted: ${scripted.length} streamGeneration lists scripted, but call ${i + 1} was made`,
                }),
              )
            }
            return Stream.fromIterable(scripted[i]!)
          }),
        ),
      streamGenerationFrom: <E, R>(
        input: Stream.Stream<MusicSessionInput, E, R>,
        request: CommonStreamGenerateMusicRequest,
      ): Stream.Stream<AudioChunk, AiError.AiError | E, R> =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* record.streamGenerationFrom(request)
            const i = yield* Ref.getAndUpdate(sgfCursor, (n) => n + 1)
            const scripted = script.streamGenerationFromChunks ?? []
            if (i >= scripted.length) {
              const exhausted: Stream.Stream<AudioChunk, AiError.AiError | E, R> = Stream.fail(
                new AiError.InvalidRequest({
                  provider: "mock",
                  raw: `MockMusicGenerator exhausted: ${scripted.length} streamGenerationFrom lists scripted, but call ${i + 1} was made`,
                }),
              )
              return exhausted
            }
            // Drain the input fully before emitting scripted audio chunks,
            // so consumers can assert on what session messages were pushed.
            return Stream.drain(input).pipe(Stream.concat(Stream.fromIterable(scripted[i]!)))
          }),
        ),
    }
    return service
  })

/**
 * Layer providing the `MusicGenerator` service AND the
 * `MusicInteractiveSession` capability marker. Use for the common case
 * where code under test exercises `streamGenerationFrom`.
 */
export const layer = (
  script: MockMusicGeneratorScript,
): {
  readonly layer: Layer.Layer<MusicGenerator | MusicInteractiveSession>
  readonly recorder: Effect.Effect<MockMusicGeneratorRecorder>
} => {
  const gCalls = Ref.makeUnsafe<ReadonlyArray<CommonGenerateMusicRequest>>([])
  const sgCalls = Ref.makeUnsafe<ReadonlyArray<CommonStreamGenerateMusicRequest>>([])
  const sgfCalls = Ref.makeUnsafe<ReadonlyArray<CommonStreamGenerateMusicRequest>>([])
  const generatorLayer = Layer.effect(
    MusicGenerator,
    makeService(script, {
      generate: (req) => Ref.update(gCalls, (xs) => [...xs, req]),
      streamGeneration: (req) => Ref.update(sgCalls, (xs) => [...xs, req]),
      streamGenerationFrom: (req) => Ref.update(sgfCalls, (xs) => [...xs, req]),
    }),
  )
  const live = Layer.merge(generatorLayer, Layer.succeed(MusicInteractiveSession, undefined))
  return {
    layer: live,
    recorder: Effect.gen(function* () {
      const generateCalls = yield* Ref.get(gCalls)
      const streamGenerationCalls = yield* Ref.get(sgCalls)
      const streamGenerationFromCalls = yield* Ref.get(sgfCalls)
      return { generateCalls, streamGenerationCalls, streamGenerationFromCalls }
    }),
  }
}

/**
 * Variant that omits the `MusicInteractiveSession` marker — simulates a
 * provider without bidirectional support (Lyria 3 sync, ElevenLabs,
 * Mureka, MiniMax, Stable Audio, Suno). Calls to
 * `streamGenerationFrom` in code under test should be a compile-time
 * error against this Layer alone.
 */
export const layerWithoutInteractive = (
  script: MockMusicGeneratorScript,
): {
  readonly layer: Layer.Layer<MusicGenerator>
  readonly recorder: Effect.Effect<MockMusicGeneratorRecorder>
} => {
  const gCalls = Ref.makeUnsafe<ReadonlyArray<CommonGenerateMusicRequest>>([])
  const sgCalls = Ref.makeUnsafe<ReadonlyArray<CommonStreamGenerateMusicRequest>>([])
  const sgfCalls = Ref.makeUnsafe<ReadonlyArray<CommonStreamGenerateMusicRequest>>([])
  const live = Layer.effect(
    MusicGenerator,
    makeService(script, {
      generate: (req) => Ref.update(gCalls, (xs) => [...xs, req]),
      streamGeneration: (req) => Ref.update(sgCalls, (xs) => [...xs, req]),
      streamGenerationFrom: (req) => Ref.update(sgfCalls, (xs) => [...xs, req]),
    }),
  )
  return {
    layer: live,
    recorder: Effect.gen(function* () {
      const generateCalls = yield* Ref.get(gCalls)
      const streamGenerationCalls = yield* Ref.get(sgCalls)
      const streamGenerationFromCalls = yield* Ref.get(sgfCalls)
      return { generateCalls, streamGenerationCalls, streamGenerationFromCalls }
    }),
  }
}
