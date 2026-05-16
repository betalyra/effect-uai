/**
 * Approval helpers for the two transport flavors.
 *
 * These helpers only decide which calls are approved and which synthetic
 * results must be returned to the model. Tool execution stays explicit at
 * the recipe boundary via `Toolkit.executeAll`.
 */
import { Data, Deferred, Effect, Queue, Scope, Stream } from "effect"
import type { FunctionCall } from "../domain/Items.js"
import { type ToolResult, cancelled, denied } from "./Outcome.js"
import { ToolEvent } from "./ToolEvent.js"

export type ToolCallPlan = {
  readonly approved: ReadonlyArray<FunctionCall>
  readonly rejected: ReadonlyArray<ToolResult>
}

export type ToolCallDecision = Data.TaggedEnum<{
  Approved: { readonly call: FunctionCall }
  Rejected: { readonly result: ToolResult }
}>

export const ToolCallDecision = Data.taggedEnum<ToolCallDecision>()

export const approve = (call: FunctionCall): ToolCallDecision =>
  ToolCallDecision.Approved({ call })

export const reject = (result: ToolResult): ToolCallDecision =>
  ToolCallDecision.Rejected({ result })

export const splitToolCallDecisions = (decisions: ReadonlyArray<ToolCallDecision>): ToolCallPlan =>
  decisions.reduce<ToolCallPlan>(
    (acc, decision) =>
      decision._tag === "Approved"
        ? { ...acc, approved: [...acc.approved, decision.call] }
        : { ...acc, rejected: [...acc.rejected, decision.result] },
    { approved: [], rejected: [] },
  )

export const approvalRequested = (call: FunctionCall): ToolEvent =>
  ToolEvent.ApprovalRequested({
    call_id: call.call_id,
    tool: call.name,
    arguments: call.arguments,
  })

// ---------------------------------------------------------------------------
// Verdict queue (WebSocket-style transport).
// ---------------------------------------------------------------------------

export type Verdict = {
  readonly call_id: string
  readonly decision: "approve" | "deny"
  readonly reason?: string
}

/**
 * Queue-backed approval planner. Safe calls are returned immediately in
 * `approved`; gated calls emit `ApprovalRequested` events and later produce
 * one `ToolCallDecision` when their matching verdict arrives.
 */
export const fromVerdictQueue =
  (predicate: (call: FunctionCall) => boolean, verdicts: Queue.Dequeue<Verdict>) =>
  (
    calls: ReadonlyArray<FunctionCall>,
  ): Effect.Effect<
    {
      readonly approved: ReadonlyArray<FunctionCall>
      readonly decisions: Stream.Stream<ToolCallDecision>
      readonly announce: Stream.Stream<ToolEvent>
    },
    never,
    Scope.Scope
  > =>
    Effect.gen(function* () {
      const gated = calls.filter(predicate)
      const approved = calls.filter((call) => !predicate(call))

      const entries = yield* Effect.forEach(gated, (call) =>
        Deferred.make<Verdict>().pipe(Effect.map((d) => [call.call_id, d] as const)),
      )
      const deferreds: ReadonlyMap<string, Deferred.Deferred<Verdict>> = new Map(entries)

      // Router is forked into the surrounding Scope so it lives as long
      // as the consumer is pulling events. Recipes typically supply the
      // scope by wrapping the events construction in `Stream.unwrap`.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            const v = yield* Queue.take(verdicts)
            const d = deferreds.get(v.call_id)
            if (d !== undefined) yield* Deferred.succeed(d, v)
          }),
        ),
      )

      const decisions = Stream.fromIterable(gated).pipe(
        Stream.flatMap(
          (call) => {
            const d = deferreds.get(call.call_id)!
            return Stream.fromEffect(
              Deferred.await(d).pipe(
                Effect.map((v) =>
                  v.decision === "approve" ? approve(call) : reject(denied(call, v.reason)),
                ),
              ),
            )
          },
          { concurrency: "unbounded" },
        ),
      )

      const announce = Stream.fromIterable<ToolEvent>(gated.map(approvalRequested))

      return { approved, decisions, announce }
    })

// ---------------------------------------------------------------------------
// Approval map (HTTP-style transport). Verdicts arrive synchronously
// bundled in the request payload. Missing entries → cancelled.
// ---------------------------------------------------------------------------

export type ApprovalMapEntry =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly reason?: string }

export const fromApprovalMap =
  (predicate: (call: FunctionCall) => boolean, approvals: ReadonlyMap<string, ApprovalMapEntry>) =>
  (calls: ReadonlyArray<FunctionCall>): ToolCallPlan =>
    splitToolCallDecisions(
      calls.map((call) => {
        if (!predicate(call)) return approve(call)
        const v = approvals.get(call.call_id)
        if (v === undefined) return reject(cancelled(call))
        return v.decision === "approve" ? approve(call) : reject(denied(call, v.reason))
      }),
    )
