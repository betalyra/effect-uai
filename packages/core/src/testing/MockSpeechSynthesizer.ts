import { Effect, Layer, Ref, Stream } from "effect"
import type { AudioBlob, AudioChunk } from "../domain/Audio.js"
import * as AiError from "../domain/AiError.js"
import {
  type CommonStreamSynthesizeRequest,
  type CommonSynthesizeDialogueRequest,
  type CommonSynthesizeRequest,
  MultiSpeakerTts,
  SpeechSynthesizer,
  type SpeechSynthesizerService,
  TtsIncrementalText,
} from "../speech-synthesizer/SpeechSynthesizer.js"

export type MockSynthesizerRecorder = {
  readonly synthesizeCalls: ReadonlyArray<CommonSynthesizeRequest>
  readonly streamSynthesisCalls: ReadonlyArray<CommonSynthesizeRequest>
  readonly streamSynthesisFromCalls: ReadonlyArray<CommonStreamSynthesizeRequest>
  readonly synthesizeDialogueCalls: ReadonlyArray<CommonSynthesizeDialogueRequest>
  readonly streamSynthesizeDialogueCalls: ReadonlyArray<CommonSynthesizeDialogueRequest>
}

export type MockSynthesizerScript = {
  /** One blob per `synthesize` call, consumed in order. */
  readonly blobs?: ReadonlyArray<AudioBlob>
  /** One chunk-list per `streamSynthesis` call, consumed in order. */
  readonly streamSynthesisChunks?: ReadonlyArray<ReadonlyArray<AudioChunk>>
  /** One chunk-list per `streamSynthesisFrom` call, consumed in order. */
  readonly streamSynthesisFromChunks?: ReadonlyArray<ReadonlyArray<AudioChunk>>
  /** One blob per `synthesizeDialogue` call, consumed in order. */
  readonly dialogueBlobs?: ReadonlyArray<AudioBlob>
  /** One chunk-list per `streamSynthesizeDialogue` call, consumed in order. */
  readonly streamSynthesizeDialogueChunks?: ReadonlyArray<ReadonlyArray<AudioChunk>>
}

type Record = {
  readonly synthesize: (req: CommonSynthesizeRequest) => Effect.Effect<void>
  readonly streamSynthesis: (req: CommonSynthesizeRequest) => Effect.Effect<void>
  readonly streamSynthesisFrom: (req: CommonStreamSynthesizeRequest) => Effect.Effect<void>
  readonly synthesizeDialogue: (req: CommonSynthesizeDialogueRequest) => Effect.Effect<void>
  readonly streamSynthesizeDialogue: (req: CommonSynthesizeDialogueRequest) => Effect.Effect<void>
}

const exhausted = (label: string, scripted: number, call: number): AiError.AiError =>
  new AiError.InvalidRequest({
    provider: "mock",
    raw: `MockSpeechSynthesizer exhausted: ${scripted} ${label} scripted, but call ${call} was made`,
  })

const makeService = (script: MockSynthesizerScript, record: Record) =>
  Effect.gen(function* () {
    const bCursor = yield* Ref.make(0)
    const ssCursor = yield* Ref.make(0)
    const ssfCursor = yield* Ref.make(0)
    const sdCursor = yield* Ref.make(0)
    const ssdCursor = yield* Ref.make(0)
    const service: SpeechSynthesizerService = {
      synthesize: (request) =>
        Effect.gen(function* () {
          yield* record.synthesize(request)
          const i = yield* Ref.getAndUpdate(bCursor, (n) => n + 1)
          const scripted = script.blobs ?? []
          if (i >= scripted.length) return yield* exhausted("blobs", scripted.length, i + 1)
          return scripted[i]!
        }),
      streamSynthesis: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* record.streamSynthesis(request)
            const i = yield* Ref.getAndUpdate(ssCursor, (n) => n + 1)
            const scripted = script.streamSynthesisChunks ?? []
            if (i >= scripted.length) {
              return Stream.fail(exhausted("streamSynthesis lists", scripted.length, i + 1))
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
              const fail: Stream.Stream<AudioChunk, AiError.AiError | E, R> = Stream.fail(
                exhausted("streamSynthesisFrom lists", scripted.length, i + 1),
              )
              return fail
            }
            return Stream.drain(textIn).pipe(Stream.concat(Stream.fromIterable(scripted[i]!)))
          }),
        ),
      synthesizeDialogue: (request) =>
        Effect.gen(function* () {
          yield* record.synthesizeDialogue(request)
          const i = yield* Ref.getAndUpdate(sdCursor, (n) => n + 1)
          const scripted = script.dialogueBlobs ?? []
          if (i >= scripted.length) {
            return yield* exhausted("dialogueBlobs", scripted.length, i + 1)
          }
          return scripted[i]!
        }),
      streamSynthesizeDialogue: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* record.streamSynthesizeDialogue(request)
            const i = yield* Ref.getAndUpdate(ssdCursor, (n) => n + 1)
            const scripted = script.streamSynthesizeDialogueChunks ?? []
            if (i >= scripted.length) {
              return Stream.fail(
                exhausted("streamSynthesizeDialogue lists", scripted.length, i + 1),
              )
            }
            return Stream.fromIterable(scripted[i]!)
          }),
        ),
    }
    return service
  })

type CallBuffers = {
  readonly bCalls: Ref.Ref<ReadonlyArray<CommonSynthesizeRequest>>
  readonly ssCalls: Ref.Ref<ReadonlyArray<CommonSynthesizeRequest>>
  readonly ssfCalls: Ref.Ref<ReadonlyArray<CommonStreamSynthesizeRequest>>
  readonly sdCalls: Ref.Ref<ReadonlyArray<CommonSynthesizeDialogueRequest>>
  readonly ssdCalls: Ref.Ref<ReadonlyArray<CommonSynthesizeDialogueRequest>>
}

const newBuffers = (): CallBuffers => ({
  bCalls: Ref.makeUnsafe<ReadonlyArray<CommonSynthesizeRequest>>([]),
  ssCalls: Ref.makeUnsafe<ReadonlyArray<CommonSynthesizeRequest>>([]),
  ssfCalls: Ref.makeUnsafe<ReadonlyArray<CommonStreamSynthesizeRequest>>([]),
  sdCalls: Ref.makeUnsafe<ReadonlyArray<CommonSynthesizeDialogueRequest>>([]),
  ssdCalls: Ref.makeUnsafe<ReadonlyArray<CommonSynthesizeDialogueRequest>>([]),
})

const recordFor = (b: CallBuffers): Record => ({
  synthesize: (req) => Ref.update(b.bCalls, (xs) => [...xs, req]),
  streamSynthesis: (req) => Ref.update(b.ssCalls, (xs) => [...xs, req]),
  streamSynthesisFrom: (req) => Ref.update(b.ssfCalls, (xs) => [...xs, req]),
  synthesizeDialogue: (req) => Ref.update(b.sdCalls, (xs) => [...xs, req]),
  streamSynthesizeDialogue: (req) => Ref.update(b.ssdCalls, (xs) => [...xs, req]),
})

const recorderEffect = (b: CallBuffers): Effect.Effect<MockSynthesizerRecorder> =>
  Effect.gen(function* () {
    const synthesizeCalls = yield* Ref.get(b.bCalls)
    const streamSynthesisCalls = yield* Ref.get(b.ssCalls)
    const streamSynthesisFromCalls = yield* Ref.get(b.ssfCalls)
    const synthesizeDialogueCalls = yield* Ref.get(b.sdCalls)
    const streamSynthesizeDialogueCalls = yield* Ref.get(b.ssdCalls)
    return {
      synthesizeCalls,
      streamSynthesisCalls,
      streamSynthesisFromCalls,
      synthesizeDialogueCalls,
      streamSynthesizeDialogueCalls,
    }
  })

/**
 * Layer providing `SpeechSynthesizer` plus both capability markers
 * (`TtsIncrementalText` and `MultiSpeakerTts`). Use for the common case
 * where code under test exercises any of the optional methods.
 */
export const layer = (
  script: MockSynthesizerScript,
): {
  readonly layer: Layer.Layer<SpeechSynthesizer | TtsIncrementalText | MultiSpeakerTts>
  readonly recorder: Effect.Effect<MockSynthesizerRecorder>
} => {
  const buffers = newBuffers()
  const synthesizerLayer = Layer.effect(
    SpeechSynthesizer,
    makeService(script, recordFor(buffers)),
  )
  const live = Layer.mergeAll(
    synthesizerLayer,
    Layer.succeed(TtsIncrementalText, undefined),
    Layer.succeed(MultiSpeakerTts, undefined),
  )
  return { layer: live, recorder: recorderEffect(buffers) }
}

/**
 * Variant that omits the `TtsIncrementalText` marker — simulates a
 * provider without incremental-text-in support (e.g. OpenAI). Calls to
 * `streamSynthesisFrom` in code under test should be a compile-time
 * error. `MultiSpeakerTts` is still provided.
 */
export const layerWithoutIncremental = (
  script: MockSynthesizerScript,
): {
  readonly layer: Layer.Layer<SpeechSynthesizer | MultiSpeakerTts>
  readonly recorder: Effect.Effect<MockSynthesizerRecorder>
} => {
  const buffers = newBuffers()
  const live = Layer.merge(
    Layer.effect(SpeechSynthesizer, makeService(script, recordFor(buffers))),
    Layer.succeed(MultiSpeakerTts, undefined),
  )
  return { layer: live, recorder: recorderEffect(buffers) }
}

/**
 * Variant that omits the `MultiSpeakerTts` marker — simulates a
 * provider without multi-speaker dialogue support (e.g. OpenAI,
 * Inworld). Calls to `synthesizeDialogue` /
 * `streamSynthesizeDialogue` in code under test should be a
 * compile-time error.
 */
export const layerWithoutMultiSpeaker = (
  script: MockSynthesizerScript,
): {
  readonly layer: Layer.Layer<SpeechSynthesizer | TtsIncrementalText>
  readonly recorder: Effect.Effect<MockSynthesizerRecorder>
} => {
  const buffers = newBuffers()
  const live = Layer.merge(
    Layer.effect(SpeechSynthesizer, makeService(script, recordFor(buffers))),
    Layer.succeed(TtsIncrementalText, undefined),
  )
  return { layer: live, recorder: recorderEffect(buffers) }
}
