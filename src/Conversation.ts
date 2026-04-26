import { Effect, Option, Stream } from "effect"
import type { AiError } from "./AiError.js"
import type { Item } from "./Items.js"
import { LanguageModel, turn as runTurn } from "./LanguageModel.js"
import type { Turn } from "./Turn.js"
import { functionCalls } from "./Turn.js"
import { executeAll, type AnyTool, type Toolkit, type ToolsR } from "./Toolkit.js"
import type { ToolError } from "./Tool.js"

/**
 * A snapshot of the conversation immediately after one turn was generated.
 *
 * - `history` contains the full message log including the items just emitted
 *   by the assistant for this turn.
 * - `turn` is the just-generated turn (items, usage, stop_reason).
 * - `index` is the 0-based turn index.
 */
export interface Cursor {
  readonly history: ReadonlyArray<Item>
  readonly turn: Turn
  readonly index: number
}

/**
 * The user's step function: given the cursor that just emitted, decide
 * either to continue (return the next history) or stop (return `undefined`).
 *
 * This is *pure data flow*. No callbacks, no while loops. Compose with
 * `Effect.flatMap`, `Effect.map`, `Effect.forEach`.
 */
export type Step<E, R> = (cursor: Cursor) => Effect.Effect<ReadonlyArray<Item> | undefined, E, R>

/**
 * The functional loop primitive: a typed `Stream.paginate` that calls the
 * language model for each turn and lets the user decide whether to continue.
 *
 * `paginate` (vs `unfold`) is used so the *final* cursor — the one whose
 * step decides to stop — is still emitted before the stream terminates.
 *
 * The implementation is the function below. Read it; nothing is hidden.
 */
export const unfold = <E, R>(
  initial: ReadonlyArray<Item>,
  step: Step<E, R>,
): Stream.Stream<Cursor, E | AiError, R | LanguageModel> =>
  Stream.paginate(
    { history: initial, index: 0 } as {
      history: ReadonlyArray<Item>
      index: number
    },
    (s) =>
      runTurn(s.history).pipe(
        Effect.flatMap((turn) => {
          const cursor: Cursor = {
            history: [...s.history, ...turn.items],
            turn,
            index: s.index,
          }
          return step(cursor).pipe(
            Effect.map(
              (next) =>
                [
                  [cursor] as ReadonlyArray<Cursor>,
                  next === undefined
                    ? Option.none<{ history: ReadonlyArray<Item>; index: number }>()
                    : Option.some({ history: next, index: s.index + 1 }),
                ] as const,
            ),
          )
        }),
      ),
  )

/**
 * The default step: if the assistant produced any function_call items,
 * execute them and append their outputs to the history. Otherwise stop.
 *
 * Six lines. Anything else you want, fork it.
 */
export const defaultStep =
  <Tools extends ReadonlyArray<AnyTool>>(toolkit: Toolkit<Tools>): Step<ToolError, ToolsR<Tools>> =>
  ({ history, turn }) => {
    const calls = functionCalls(turn)
    if (calls.length === 0) return Effect.succeed(undefined)
    return executeAll(toolkit, calls).pipe(Effect.map((outputs) => [...history, ...outputs]))
  }
