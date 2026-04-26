import { Effect, Layer, Ref, Stream } from "effect"
import { AiError } from "../AiError.js"
import type { Item } from "../Items.js"
import { LanguageModel, type LanguageModelService } from "../LanguageModel.js"
import type { Turn, TurnDelta } from "../Turn.js"

/**
 * A scripted mock provider. Pre-canned `Turn` outputs are returned in order,
 * one per call to `streamTurn`. Each scripted turn is split into synthetic
 * deltas (text → tool_call_start → tool_call_args_delta → ... → turn_complete)
 * so streaming consumers can see realistic delta shapes.
 */
export interface MockRecorder {
  readonly calls: ReadonlyArray<{
    readonly history: ReadonlyArray<Item>
    readonly turn: Turn
  }>
}

const turnToDeltas = (turn: Turn): ReadonlyArray<TurnDelta> => {
  const deltas: TurnDelta[] = []
  for (const item of turn.items) {
    if (item.type === "message" && item.role === "assistant") {
      for (const block of item.content) {
        if (block.type === "output_text") {
          deltas.push({ type: "text_delta", text: block.text })
        }
      }
    } else if (item.type === "function_call") {
      deltas.push({
        type: "tool_call_start",
        call_id: item.call_id,
        name: item.name
      })
      deltas.push({
        type: "tool_call_args_delta",
        call_id: item.call_id,
        delta: item.arguments
      })
    }
  }
  deltas.push({ type: "turn_complete", turn })
  return deltas
}

const makeService = (
  scriptedTurns: ReadonlyArray<Turn>,
  recordCall?: (
    history: ReadonlyArray<Item>,
    turn: Turn
  ) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const cursor = yield* Ref.make(0)
    return LanguageModel.of({
      streamTurn: (history) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(cursor, (n) => n + 1)
            if (i >= scriptedTurns.length) {
              return Stream.fail(
                new AiError({
                  message: `MockProvider exhausted: ${scriptedTurns.length} turns scripted, but call ${i + 1} was made`
                })
              )
            }
            const turn = scriptedTurns[i]!
            if (recordCall !== undefined) {
              yield* recordCall(history, turn)
            }
            return Stream.fromIterable(turnToDeltas(turn))
          })
        )
    })
  })

export const layer = (
  scriptedTurns: ReadonlyArray<Turn>
): Layer.Layer<LanguageModel> =>
  Layer.effect(LanguageModel, makeService(scriptedTurns))

/**
 * Synchronous constructor that returns the `LanguageModelService` value
 * directly, plus a recorder. Use this when you want to swap models
 * mid-stream via `Effect.provideService` instead of providing one model
 * for the whole program via `Layer`.
 */
export const make = (
  scriptedTurns: ReadonlyArray<Turn>
): {
  readonly service: LanguageModelService
  readonly recorder: Effect.Effect<MockRecorder>
} => {
  const cursor = Ref.makeUnsafe(0)
  const callsRef = Ref.makeUnsafe<
    ReadonlyArray<{ history: ReadonlyArray<Item>; turn: Turn }>
  >([])
  const service: LanguageModelService = {
    streamTurn: (history) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const i = yield* Ref.getAndUpdate(cursor, (n) => n + 1)
          if (i >= scriptedTurns.length) {
            return Stream.fail(
              new AiError({
                message: `MockProvider exhausted: ${scriptedTurns.length} turns scripted, but call ${i + 1} was made`
              })
            )
          }
          const turn = scriptedTurns[i]!
          yield* Ref.update(callsRef, (xs) => [...xs, { history, turn }])
          return Stream.fromIterable(turnToDeltas(turn))
        })
      )
  }
  return {
    service,
    recorder: Ref.get(callsRef).pipe(Effect.map((calls) => ({ calls })))
  }
}

/**
 * Same as `layer`, but also exposes a recorder that captures every call
 * (history + returned turn).
 */
export const layerWithRecorder = (
  scriptedTurns: ReadonlyArray<Turn>
): {
  readonly layer: Layer.Layer<LanguageModel>
  readonly recorder: Effect.Effect<MockRecorder>
} => {
  const callsRef = Ref.makeUnsafe<
    ReadonlyArray<{ history: ReadonlyArray<Item>; turn: Turn }>
  >([])
  const live = Layer.effect(
    LanguageModel,
    makeService(scriptedTurns, (history, turn) =>
      Ref.update(callsRef, (xs) => [...xs, { history, turn }])
    )
  )
  return {
    layer: live,
    recorder: Ref.get(callsRef).pipe(Effect.map((calls) => ({ calls })))
  }
}
