import { Duration, Effect, Layer, Ref, Schedule, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import type { Item } from "../domain/Items.js"
import { LanguageModel, type LanguageModelService } from "../language-model/LanguageModel.js"
import { type Turn, TurnEvent } from "../domain/Turn.js"

export type MockOptions = {
  /**
   * If set, deltas of each scripted turn are spaced by this duration via
   * `Schedule.spaced`. Combine with `TestClock.adjust` for deterministic
   * timing in tests.
   */
  readonly deltaInterval?: Duration.Input
}

/**
 * A scripted mock provider. Pre-canned `Turn` outputs are returned in order,
 * one per call to `streamTurn`. Each scripted turn is split into synthetic
 * deltas (text → ToolCallStart → ToolCallArgsDelta → ... → TurnComplete)
 * so streaming consumers can see realistic delta shapes.
 */
export type MockRecorder = {
  readonly calls: ReadonlyArray<{
    readonly history: ReadonlyArray<Item>
    readonly turn: Turn
  }>
}

const turnToDeltas = (turn: Turn): ReadonlyArray<TurnEvent> => {
  const deltas: TurnEvent[] = []
  for (const item of turn.items) {
    if (item.type === "message" && item.role === "assistant") {
      for (const block of item.content) {
        if (block.type === "output_text") {
          deltas.push(TurnEvent.TextDelta({ text: block.text }))
        }
      }
    } else if (item.type === "function_call") {
      deltas.push(TurnEvent.ToolCallStart({ call_id: item.call_id, name: item.name }))
      deltas.push(TurnEvent.ToolCallArgsDelta({ call_id: item.call_id, delta: item.arguments }))
    } else if (item.type === "reasoning" && item.summary !== undefined) {
      deltas.push(TurnEvent.ReasoningDelta({ text: item.summary, kind: "summary" }))
    }
  }
  deltas.push(TurnEvent.TurnComplete({ turn }))
  return deltas
}

const pacedDeltas = (turn: Turn, options?: MockOptions): Stream.Stream<TurnEvent> => {
  const base = Stream.fromIterable(turnToDeltas(turn))
  return options?.deltaInterval === undefined
    ? base
    : base.pipe(Stream.schedule(Schedule.spaced(options.deltaInterval)))
}

const makeService = (
  scriptedTurns: ReadonlyArray<Turn>,
  options?: MockOptions,
  recordCall?: (history: ReadonlyArray<Item>, turn: Turn) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const cursor = yield* Ref.make(0)
    return LanguageModel.of({
      streamTurn: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(cursor, (n) => n + 1)
            if (i >= scriptedTurns.length) {
              return Stream.fail(
                new AiError.InvalidRequest({
                  provider: "mock",
                  raw: `MockProvider exhausted: ${scriptedTurns.length} turns scripted, but call ${i + 1} was made`,
                }),
              )
            }
            const turn = scriptedTurns[i]!
            if (recordCall !== undefined) {
              yield* recordCall(request.history, turn)
            }
            return pacedDeltas(turn, options)
          }),
        ),
    })
  })

export const layer = (
  scriptedTurns: ReadonlyArray<Turn>,
  options?: MockOptions,
): Layer.Layer<LanguageModel> => Layer.effect(LanguageModel, makeService(scriptedTurns, options))

/**
 * Synchronous constructor that returns the `LanguageModelService` value
 * directly, plus a recorder. Use this when you want to swap models
 * mid-stream via `Effect.provideService` instead of providing one model
 * for the whole program via `Layer`.
 */
export const make = (
  scriptedTurns: ReadonlyArray<Turn>,
  options?: MockOptions,
): {
  readonly service: LanguageModelService
  readonly recorder: Effect.Effect<MockRecorder>
} => {
  const cursor = Ref.makeUnsafe(0)
  const callsRef = Ref.makeUnsafe<ReadonlyArray<{ history: ReadonlyArray<Item>; turn: Turn }>>([])
  const service: LanguageModelService = {
    streamTurn: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const i = yield* Ref.getAndUpdate(cursor, (n) => n + 1)
          if (i >= scriptedTurns.length) {
            return Stream.fail(
              new AiError.InvalidRequest({
                provider: "mock",
                raw: `MockProvider exhausted: ${scriptedTurns.length} turns scripted, but call ${i + 1} was made`,
              }),
            )
          }
          const turn = scriptedTurns[i]!
          yield* Ref.update(callsRef, (xs) => [...xs, { history: request.history, turn }])
          return pacedDeltas(turn, options)
        }),
      ),
  }
  return {
    service,
    recorder: Ref.get(callsRef).pipe(Effect.map((calls) => ({ calls }))),
  }
}

/**
 * Same as `layer`, but also exposes a recorder that captures every call
 * (history + returned turn).
 */
export const layerWithRecorder = (
  scriptedTurns: ReadonlyArray<Turn>,
  options?: MockOptions,
): {
  readonly layer: Layer.Layer<LanguageModel>
  readonly recorder: Effect.Effect<MockRecorder>
} => {
  const callsRef = Ref.makeUnsafe<ReadonlyArray<{ history: ReadonlyArray<Item>; turn: Turn }>>([])
  const live = Layer.effect(
    LanguageModel,
    makeService(scriptedTurns, options, (history, turn) =>
      Ref.update(callsRef, (xs) => [...xs, { history, turn }]),
    ),
  )
  return {
    layer: live,
    recorder: Ref.get(callsRef).pipe(Effect.map((calls) => ({ calls }))),
  }
}
