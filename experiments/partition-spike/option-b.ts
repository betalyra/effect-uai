/**
 * Spike implementation of Option B from `options.md`. NOT shipped;
 * lives outside `packages/core/` until we pick a direction.
 *
 * Revised after review:
 *  - Dropped our `Toolkit.partition` helper. Use `Arr.partition` from
 *    Effect directly. The Result-wrapping cost is one line.
 *  - `executePartitioned` is now ~5 lines of actual logic on top of
 *    `Arr.partition` + `Effect.all` + `executeAllSafe`. Pure composition.
 *  - `deny` / `cancelled` moved into `tool-outcome.ts` because their
 *    payloads should match the standardized `ToolFailure` schema, not
 *    invent ad-hoc JSON.
 */
import { Array as Arr, Effect, Result } from "effect"
import {
  type FunctionCall,
  type FunctionCallOutput,
} from "@effect-uai/core/Items"
import * as Toolkit from "@effect-uai/core/Toolkit"

/**
 * Run a turn's tool calls in two paths concurrently:
 *
 *   - `safe`  - calls where `predicate` is false. Run via `onSafe`
 *               (default: `Toolkit.executeAllSafe`).
 *
 *   - `gated` - calls where `predicate` is true. Run via the user's
 *               `onGated` Effect. Typical implementations: emit an
 *               `awaiting_approval` event, wait on a verdict queue,
 *               execute approved + return cancellation/denial outputs
 *               for everything else. The framework stays out of policy.
 *
 * Outputs are returned `[...safeOutputs, ...gatedOutputs]`. Order
 * inside `history` is irrelevant to providers - only `call_id`
 * correlation matters.
 */
export const executePartitioned = <Tools extends ReadonlyArray<Toolkit.AnyTool>, RGated = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  calls: ReadonlyArray<FunctionCall>,
  options: {
    readonly predicate: (call: FunctionCall) => boolean
    readonly onGated: (
      calls: ReadonlyArray<FunctionCall>,
    ) => Effect.Effect<ReadonlyArray<FunctionCallOutput>, never, RGated>
    readonly onSafe?: (
      toolkit: Toolkit.Toolkit<Tools>,
      calls: ReadonlyArray<FunctionCall>,
    ) => Effect.Effect<ReadonlyArray<FunctionCallOutput>, never, Toolkit.ToolsR<Tools>>
  },
): Effect.Effect<
  ReadonlyArray<FunctionCallOutput>,
  never,
  Toolkit.ToolsR<Tools> | RGated
> => {
  // Arr.partition returns `[excluded, satisfying]` where `excluded` is the
  // Result.fail branch. We want safe (predicate false) on the left and
  // gated (predicate true) on the right, so map the predicate accordingly.
  const [safe, gated] = Arr.partition(calls, (call) =>
    options.predicate(call) ? Result.succeed(call) : Result.fail(call),
  )
  const safeRunner = options.onSafe ?? Toolkit.executeAllSafe
  return Effect.all(
    [safeRunner(toolkit, safe), options.onGated(gated)],
    { concurrency: "unbounded" },
  ).pipe(Effect.map(([s, g]) => [...s, ...g]))
}
