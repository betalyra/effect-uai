/**
 * Approval helpers for the two transport flavors.
 *
 * These helpers only decide which calls are approved and which synthetic
 * results must be returned to the model. Tool execution stays explicit at
 * the recipe boundary via `Toolkit.run`.
 */
import { Data, Deferred, Effect, Queue, Scope, Stream } from "effect"
import type { ToolCall } from "../domain/Items.js"
import { type ToolResult, cancelled, denied } from "./ToolResult.js"
import { ToolEvent } from "./ToolEvent.js"

export type ToolCallPlan = {
  readonly approved: ReadonlyArray<ToolCall>
  readonly rejected: ReadonlyArray<ToolResult>
}

export type ApprovalDecision = Data.TaggedEnum<{
  Approved: { readonly call: ToolCall }
  Rejected: { readonly result: ToolResult }
}>

export const ApprovalDecision = Data.taggedEnum<ApprovalDecision>()

export const approve = (call: ToolCall): ApprovalDecision => ApprovalDecision.Approved({ call })

export const reject = (result: ToolResult): ApprovalDecision =>
  ApprovalDecision.Rejected({ result })

export const splitApprovalDecisions = (decisions: ReadonlyArray<ApprovalDecision>): ToolCallPlan =>
  decisions.reduce<ToolCallPlan>(
    (acc, decision) =>
      decision._tag === "Approved"
        ? { ...acc, approved: [...acc.approved, decision.call] }
        : { ...acc, rejected: [...acc.rejected, decision.result] },
    { approved: [], rejected: [] },
  )

export const approvalRequested = (call: ToolCall): ToolEvent =>
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
 * one `ApprovalDecision` when their matching verdict arrives.
 */
export const fromQueue =
  (predicate: (call: ToolCall) => boolean, verdicts: Queue.Dequeue<Verdict>) =>
  (
    calls: ReadonlyArray<ToolCall>,
  ): Effect.Effect<
    {
      readonly approved: ReadonlyArray<ToolCall>
      readonly decisions: Stream.Stream<ApprovalDecision>
      readonly approvalRequests: Stream.Stream<ToolEvent>
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

      const approvalRequests = Stream.fromIterable<ToolEvent>(gated.map(approvalRequested))

      return { approved, decisions, approvalRequests }
    })

// ---------------------------------------------------------------------------
// Approval map (HTTP-style transport). Verdicts arrive synchronously
// bundled in the request payload. Missing entries → cancelled.
// ---------------------------------------------------------------------------

export type ApprovalMapEntry =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly reason?: string }

export const fromMap =
  (predicate: (call: ToolCall) => boolean, approvals: ReadonlyMap<string, ApprovalMapEntry>) =>
  (calls: ReadonlyArray<ToolCall>): ToolCallPlan =>
    splitApprovalDecisions(
      calls.map((call) => {
        if (!predicate(call)) return approve(call)
        const v = approvals.get(call.call_id)
        if (v === undefined) return reject(cancelled(call))
        return v.decision === "approve" ? approve(call) : reject(denied(call, v.reason))
      }),
    )
