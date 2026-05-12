import { Effect, Layer, Ref, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { TranscriptEvent, TranscriptResult } from "../domain/Transcript.js"
import {
  SttStreaming,
  Transcriber,
  type CommonStreamTranscribeRequest,
  type CommonTranscribeRequest,
  type TranscriberService,
} from "../transcriber/Transcriber.js"

/**
 * Recorder of every call made to the mock.
 */
export type MockTranscriberRecorder = {
  readonly transcribeCalls: ReadonlyArray<CommonTranscribeRequest>
  readonly streamCalls: ReadonlyArray<CommonStreamTranscribeRequest>
}

export type MockTranscriberScript = {
  /** One result per `transcribe` call, consumed in order. */
  readonly transcripts?: ReadonlyArray<TranscriptResult>
  /** One event-list per `streamTranscriptionFrom` call, consumed in order. */
  readonly streams?: ReadonlyArray<ReadonlyArray<TranscriptEvent>>
}

const makeService = (
  script: MockTranscriberScript,
  record: {
    readonly transcribe: (req: CommonTranscribeRequest) => Effect.Effect<void>
    readonly stream: (req: CommonStreamTranscribeRequest) => Effect.Effect<void>
  },
) =>
  Effect.gen(function* () {
    const tCursor = yield* Ref.make(0)
    const sCursor = yield* Ref.make(0)
    const service: TranscriberService = {
      transcribe: (request) =>
        Effect.gen(function* () {
          yield* record.transcribe(request)
          const i = yield* Ref.getAndUpdate(tCursor, (n) => n + 1)
          const scripted = script.transcripts ?? []
          if (i >= scripted.length) {
            return yield* Effect.fail(
              new AiError.InvalidRequest({
                provider: "mock",
                raw: `MockTranscriber exhausted: ${scripted.length} transcripts scripted, but call ${i + 1} was made`,
              }),
            )
          }
          return scripted[i]!
        }),
      streamTranscriptionFrom: <E, R>(
        audioIn: Stream.Stream<Uint8Array, E, R>,
        request: CommonStreamTranscribeRequest,
      ): Stream.Stream<TranscriptEvent, AiError.AiError | E, R> =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* record.stream(request)
            const i = yield* Ref.getAndUpdate(sCursor, (n) => n + 1)
            const scripted = script.streams ?? []
            if (i >= scripted.length) {
              const exhausted: Stream.Stream<TranscriptEvent, AiError.AiError | E, R> =
                Stream.fail(
                  new AiError.InvalidRequest({
                    provider: "mock",
                    raw: `MockTranscriber exhausted: ${scripted.length} streams scripted, but call ${i + 1} was made`,
                  }),
                )
              return exhausted
            }
            // Drain the input audio fully before emitting the scripted events,
            // so consumers can assert on what bytes were pushed.
            return Stream.drain(audioIn).pipe(Stream.concat(Stream.fromIterable(scripted[i]!)))
          }),
        ),
    }
    return service
  })

/**
 * Returns a Layer that provides both the `Transcriber` service and the
 * `SttStreaming` capability marker. Use when the code under test calls
 * `streamTranscriptionFrom`.
 */
export const layer = (
  script: MockTranscriberScript,
): {
  readonly layer: Layer.Layer<Transcriber | SttStreaming>
  readonly recorder: Effect.Effect<MockTranscriberRecorder>
} => {
  const tCalls = Ref.makeUnsafe<ReadonlyArray<CommonTranscribeRequest>>([])
  const sCalls = Ref.makeUnsafe<ReadonlyArray<CommonStreamTranscribeRequest>>([])
  const transcriberLayer = Layer.effect(
    Transcriber,
    makeService(script, {
      transcribe: (req) => Ref.update(tCalls, (xs) => [...xs, req]),
      stream: (req) => Ref.update(sCalls, (xs) => [...xs, req]),
    }),
  )
  const live = Layer.merge(transcriberLayer, Layer.succeed(SttStreaming, undefined))
  return {
    layer: live,
    recorder: Effect.gen(function* () {
      const transcribeCalls = yield* Ref.get(tCalls)
      const streamCalls = yield* Ref.get(sCalls)
      return { transcribeCalls, streamCalls }
    }),
  }
}

/**
 * Variant that omits the `SttStreaming` marker — use to test that
 * consumers calling `streamTranscriptionFrom` fail to compile against
 * a non-streaming provider.
 */
export const layerSyncOnly = (
  script: MockTranscriberScript,
): {
  readonly layer: Layer.Layer<Transcriber>
  readonly recorder: Effect.Effect<MockTranscriberRecorder>
} => {
  const tCalls = Ref.makeUnsafe<ReadonlyArray<CommonTranscribeRequest>>([])
  const sCalls = Ref.makeUnsafe<ReadonlyArray<CommonStreamTranscribeRequest>>([])
  const live = Layer.effect(
    Transcriber,
    makeService(script, {
      transcribe: (req) => Ref.update(tCalls, (xs) => [...xs, req]),
      stream: (req) => Ref.update(sCalls, (xs) => [...xs, req]),
    }),
  )
  return {
    layer: live,
    recorder: Effect.gen(function* () {
      const transcribeCalls = yield* Ref.get(tCalls)
      const streamCalls = yield* Ref.get(sCalls)
      return { transcribeCalls, streamCalls }
    }),
  }
}
