import { Cause, Effect, Layer, Queue, Ref, Stream } from "effect"
import type { CommonSessionRequest, RealtimeEvent, RealtimeInput } from "../domain/Realtime.js"
import {
  RealtimeSession,
  RealtimeVideoInput,
  type RealtimeSessionHandle,
  type RealtimeSessionService,
} from "../realtime/RealtimeSession.js"

export type MockRealtimeSessionRecorder = {
  readonly openCalls: ReadonlyArray<CommonSessionRequest>
  readonly sent: ReadonlyArray<RealtimeInput>
}

export type MockRealtimeSessionScript = {
  /** Emitted as soon as the session opens. */
  readonly initial?: ReadonlyArray<RealtimeEvent>
  /** The server's answer to each input. */
  readonly onInput?: (input: RealtimeInput) => ReadonlyArray<RealtimeEvent>
}

type Recorders = {
  readonly open: (request: CommonSessionRequest) => Effect.Effect<void>
  readonly send: (input: RealtimeInput) => Effect.Effect<void>
}

const makeService = (
  script: MockRealtimeSessionScript,
  record: Recorders,
): RealtimeSessionService => ({
  open: (request) =>
    Effect.gen(function* () {
      yield* record.open(request)
      const queue = yield* Queue.unbounded<RealtimeEvent, Cause.Done>()
      // Closing the scope ends `events`, leaving anything already queued to drain.
      yield* Effect.addFinalizer(() => Queue.end(queue))
      yield* Queue.offerAll(queue, script.initial ?? [])
      const handle: RealtimeSessionHandle = {
        send: (input) =>
          Effect.andThen(
            record.send(input),
            Queue.offerAll(queue, script.onInput?.(input) ?? []),
          ).pipe(Effect.asVoid),
        events: Stream.fromQueue(queue),
      }
      return handle
    }),
})

const build = (script: MockRealtimeSessionScript) => {
  const openCalls = Ref.makeUnsafe<ReadonlyArray<CommonSessionRequest>>([])
  const sent = Ref.makeUnsafe<ReadonlyArray<RealtimeInput>>([])
  const sessionLayer = Layer.succeed(
    RealtimeSession,
    makeService(script, {
      open: (request) => Ref.update(openCalls, (xs) => [...xs, request]),
      send: (input) => Ref.update(sent, (xs) => [...xs, input]),
    }),
  )
  const recorder: Effect.Effect<MockRealtimeSessionRecorder> = Effect.gen(function* () {
    return { openCalls: yield* Ref.get(openCalls), sent: yield* Ref.get(sent) }
  })
  return { sessionLayer, recorder }
}

/** Scripted session that also ships the `RealtimeVideoInput` marker. */
export const layer = (
  script: MockRealtimeSessionScript,
): {
  readonly layer: Layer.Layer<RealtimeSession | RealtimeVideoInput>
  readonly recorder: Effect.Effect<MockRealtimeSessionRecorder>
} => {
  const { sessionLayer, recorder } = build(script)
  return {
    layer: Layer.merge(sessionLayer, Layer.succeed(RealtimeVideoInput, undefined)),
    recorder,
  }
}

/**
 * The same without the marker, to test that a caller sending video against an
 * audio-only provider fails to compile.
 */
export const layerAudioOnly = (
  script: MockRealtimeSessionScript,
): {
  readonly layer: Layer.Layer<RealtimeSession>
  readonly recorder: Effect.Effect<MockRealtimeSessionRecorder>
} => {
  const { sessionLayer, recorder } = build(script)
  return { layer: sessionLayer, recorder }
}
