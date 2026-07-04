/**
 * Approval helpers for the two transport flavors.
 *
 * These helpers only decide which calls are approved and which synthetic
 * results must be returned to the model. Tool execution stays explicit at
 * the recipe boundary via `Toolkit.run`.
 */
import { Data, Deferred, type Duration, Effect, Queue, Ref, Scope, Stream } from "effect"
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

export type FromQueueOptions = {
  /**
   * Resolve any still-pending gated call as `cancelled` once this elapses,
   * so a lost or never-sent verdict cannot hang the decisions stream
   * forever. Omit to wait indefinitely.
   */
  readonly timeout?: Duration.Input
}

/**
 * Queue-backed approval planner. Safe calls are returned immediately in
 * `approved`; gated calls emit `ApprovalRequested` events and later produce
 * one `ApprovalDecision` when their matching verdict arrives.
 *
 * The verdict queue is a single-consumer transport: run one approval round
 * at a time (the router retires once every gated call of the round is
 * resolved). For overlapping rounds, use one queue per round.
 */
export const fromQueue =
  (
    predicate: (call: ToolCall) => boolean,
    verdicts: Queue.Dequeue<Verdict>,
    options?: FromQueueOptions,
  ) =>
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
        Deferred.make<ApprovalDecision>().pipe(Effect.map((d) => [call.call_id, d] as const)),
      )
      const deferreds: ReadonlyMap<string, Deferred.Deferred<ApprovalDecision>> = new Map(entries)
      const callById: ReadonlyMap<string, ToolCall> = new Map(gated.map((c) => [c.call_id, c]))
      const outstanding = yield* Ref.make(gated.length)

      // Complete a deferred once; decrement only on the winning transition so
      // a late verdict for an already-resolved call is a no-op.
      const resolve = (call: ToolCall, decision: ApprovalDecision) =>
        Deferred.succeed(deferreds.get(call.call_id)!, decision).pipe(
          Effect.flatMap((won) => (won ? Ref.update(outstanding, (n) => n - 1) : Effect.void)),
        )

      // Router retires once every gated call is resolved (by verdict or
      // timeout), so sequential rounds over one queue do not accumulate
      // racing routers. Recursive + suspended: stack-safe, no imperative loop.
      const route: Effect.Effect<void> = Effect.suspend(() =>
        Ref.get(outstanding).pipe(
          Effect.flatMap((n) =>
            n <= 0
              ? Effect.void
              : Queue.take(verdicts).pipe(
                  Effect.flatMap((v) => {
                    const call = callById.get(v.call_id)
                    return (
                      call === undefined
                        ? Effect.void
                        : resolve(
                            call,
                            v.decision === "approve"
                              ? approve(call)
                              : reject(denied(call, v.reason)),
                          )
                    ).pipe(Effect.andThen(route))
                  }),
                ),
          ),
        ),
      )

      if (gated.length > 0) {
        yield* Effect.forkScoped(route)
        if (options?.timeout !== undefined) {
          yield* Effect.forkScoped(
            Effect.sleep(options.timeout).pipe(
              Effect.andThen(
                Effect.forEach(gated, (call) =>
                  resolve(call, reject(cancelled(call, "approval timed out"))),
                ),
              ),
            ),
          )
        }
      }

      const decisions = Stream.fromIterable(gated).pipe(
        Stream.flatMap((call) => Stream.fromEffect(Deferred.await(deferreds.get(call.call_id)!)), {
          concurrency: "unbounded",
        }),
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
