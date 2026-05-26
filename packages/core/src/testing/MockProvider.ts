import { Array as Arr, Duration, Effect, Layer, Match, Option, Ref, Schedule, Stream } from "effect"
import * as AiError from "../domain/AiError.js"
import { type HistoryItem, isOutputText } from "../domain/Items.js"
import {
  LanguageModel,
  type LanguageModelService,
  turnFromStream,
} from "../language-model/LanguageModel.js"
import { type Turn, TurnEvent } from "../domain/Turn.js"

export type MockOptions = {
  /**
   * If set, deltas of each scripted turn are spaced by this duration via
   * `Schedule.spaced`. Combine with `TestClock.adjust` for deterministic
   * timing in tests.
   */
  readonly deltaInterval?: Duration.Input
}

export type Call = {
  readonly history: ReadonlyArray<HistoryItem>
  readonly turn: Turn
}

/**
 * A scripted mock provider. Pre-canned `Turn` outputs are returned in order,
 * one per call to `streamTurn`. Each scripted turn is split into synthetic
 * deltas (text → ToolCallStart → ToolCallArgsDelta → ... → TurnComplete)
 * so streaming consumers can see realistic delta shapes.
 */
export type MockRecorder = {
  readonly calls: ReadonlyArray<Call>
}

// ---------------------------------------------------------------------------
// Pure projection: Turn → ReadonlyArray<TurnEvent>
// ---------------------------------------------------------------------------

const itemToDeltas: (item: HistoryItem) => ReadonlyArray<TurnEvent> = Match.type<HistoryItem>().pipe(
  Match.discriminators("type")({
    message: (m): ReadonlyArray<TurnEvent> =>
      m.role === "assistant"
        ? m.content.filter(isOutputText).map((b) => TurnEvent.TextDelta({ text: b.text }))
        : [],
    function_call: (fc) => [
      TurnEvent.ToolCallStart({ call_id: fc.call_id, name: fc.name }),
      TurnEvent.ToolCallArgsDelta({ call_id: fc.call_id, delta: fc.arguments }),
    ],
    function_call_output: () => [],
    reasoning: (r) =>
      r.summary !== undefined
        ? [TurnEvent.ReasoningDelta({ text: r.summary, kind: "summary" as const })]
        : [],
  }),
  Match.exhaustive,
)

const turnToDeltas = (turn: Turn): ReadonlyArray<TurnEvent> => [
  ...turn.items.flatMap(itemToDeltas),
  TurnEvent.TurnComplete({ turn }),
]

const pacedDeltas = (turn: Turn, options?: MockOptions): Stream.Stream<TurnEvent> => {
  const base = Stream.fromIterable(turnToDeltas(turn))
  return options?.deltaInterval === undefined
    ? base
    : base.pipe(Stream.schedule(Schedule.spaced(options.deltaInterval)))
}

// ---------------------------------------------------------------------------
// Canonical service factory. One implementation; sync/Layer/recorder
// variants below are just different ways to wire the cursor + record hook.
// ---------------------------------------------------------------------------

const exhausted = (n: number, attempt: number): AiError.AiError =>
  new AiError.InvalidRequest({
    provider: "mock",
    raw: `MockProvider exhausted: ${n} turns scripted, but call ${attempt} was made`,
  })

const noRecord = (_: Call): Effect.Effect<void> => Effect.void

const buildService = (
  scriptedTurns: ReadonlyArray<Turn>,
  options: MockOptions | undefined,
  cursor: Ref.Ref<number>,
  record: (call: Call) => Effect.Effect<void>,
): LanguageModelService => {
  const streamTurn: LanguageModelService["streamTurn"] = (request) =>
    Stream.unwrap(
      Ref.getAndUpdate(cursor, (n) => n + 1).pipe(
        Effect.flatMap(
          (i): Effect.Effect<Stream.Stream<TurnEvent, AiError.AiError>> =>
            Option.match(Arr.get(scriptedTurns, i), {
              onNone: () => Effect.succeed(Stream.fail(exhausted(scriptedTurns.length, i + 1))),
              onSome: (turn) =>
                record({ history: request.history, turn }).pipe(
                  Effect.as(pacedDeltas(turn, options)),
                ),
            }),
        ),
      ),
    )
  return { streamTurn, turn: turnFromStream(streamTurn) }
}

// ---------------------------------------------------------------------------
// Recorder handle. Unsafe Ref is local: it backs both the `record` write
// hook (called inside the service) and the `recorder` read effect (called
// by the test). Both close over the same cell.
// ---------------------------------------------------------------------------

type RecorderHandle = {
  readonly record: (call: Call) => Effect.Effect<void>
  readonly recorder: Effect.Effect<MockRecorder>
}

const makeRecorderUnsafe = (): RecorderHandle => {
  const ref = Ref.makeUnsafe<ReadonlyArray<Call>>([])
  return {
    record: (call) => Ref.update(ref, Arr.append(call)),
    recorder: Ref.get(ref).pipe(Effect.map((calls): MockRecorder => ({ calls }))),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Layer that registers a `MockProvider` against the `LanguageModel` tag.
 * Calls beyond the scripted turn count fail with `InvalidRequest`.
 */
export const layer = (
  scriptedTurns: ReadonlyArray<Turn>,
  options?: MockOptions,
): Layer.Layer<LanguageModel> =>
  Layer.effect(
    LanguageModel,
    Ref.make(0).pipe(
      Effect.map((cursor) => buildService(scriptedTurns, options, cursor, noRecord)),
    ),
  )

/**
 * Like `layer`, but also exposes a recorder that captures every call
 * (history + returned turn).
 */
export const layerWithRecorder = (
  scriptedTurns: ReadonlyArray<Turn>,
  options?: MockOptions,
): {
  readonly layer: Layer.Layer<LanguageModel>
  readonly recorder: Effect.Effect<MockRecorder>
} => {
  const { record, recorder } = makeRecorderUnsafe()
  return {
    layer: Layer.effect(
      LanguageModel,
      Ref.make(0).pipe(
        Effect.map((cursor) => buildService(scriptedTurns, options, cursor, record)),
      ),
    ),
    recorder,
  }
}

/**
 * Build the `LanguageModelService` value directly (no Layer), plus a
 * recorder. Use this when you want to swap models mid-program via
 * `Effect.provideService` instead of providing one model for the whole
 * program via `Layer`.
 */
export const make = (
  scriptedTurns: ReadonlyArray<Turn>,
  options?: MockOptions,
): {
  readonly service: LanguageModelService
  readonly recorder: Effect.Effect<MockRecorder>
} => {
  const cursor = Ref.makeUnsafe(0)
  const { record, recorder } = makeRecorderUnsafe()
  return {
    service: buildService(scriptedTurns, options, cursor, record),
    recorder,
  }
}
