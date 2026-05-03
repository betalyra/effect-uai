/**
 * Library: ready-made `Resolver`s for the two transport flavors plus
 * combinators for layering policy on top.
 *
 *   - `fromVerdictQueue` : long-lived channel (WebSocket / SSE). Verdicts
 *                          arrive over time on a shared queue. Returns
 *                          a setup `Effect` that wires per-call Deferreds
 *                          and a router fiber, then yields the resolver
 *                          plus a stream of `ApprovalRequested` events
 *                          the recipe can merge into the consumer view.
 *
 *   - `fromApprovalMap`  : request-shaped (HTTP chat). All approvals are
 *                          known synchronously, bundled in the request
 *                          payload. Calls without a verdict resolve to
 *                          `Reject(cancelled(call))` so history stays
 *                          well-formed.
 *
 *   - `withPermissions`  : composable wrapper. Runs an authz check before
 *                          delegating to the inner resolver. Failed checks
 *                          short-circuit to `Reject(permissionDenied)`.
 *
 *   - `withFallback`     : composable wrapper. If the inner resolver
 *                          returns Reject, run an alternate tool instead.
 *
 * Each helper is small and explicit. None of them know about the
 * executor's stream shape; they just produce `Effect<ToolDecision>`s.
 */
import { Deferred, Effect, Queue, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import {
  type ToolDecision,
  cancelled,
  denied,
  execute,
  reject,
  rejected,
} from "./Outcome.js"
import type { Resolver } from "./executor.js"
import type { ToolEvent } from "./ToolEvent.js"
import type { Verdict } from "./Verdict.js"

// ---------------------------------------------------------------------------
// `fromVerdictQueue` - long-lived channel transport.
// ---------------------------------------------------------------------------

export const fromVerdictQueue =
  (
    predicate: (call: Items.FunctionCall) => boolean,
    verdicts: Queue.Dequeue<Verdict>,
  ) =>
  (
    calls: ReadonlyArray<Items.FunctionCall>,
  ): Effect.Effect<{
    readonly resolve: Resolver
    readonly announce: Stream.Stream<ToolEvent>
  }> =>
    Effect.gen(function* () {
      const gated = calls.filter(predicate)

      const entries = yield* Effect.forEach(gated, (call) =>
        Deferred.make<Verdict>().pipe(
          Effect.map((d) => [call.call_id, d] as const),
        ),
      )
      const deferreds: ReadonlyMap<string, Deferred.Deferred<Verdict>> = new Map(entries)

      yield* Effect.forkChild(
        Effect.forever(
          Effect.gen(function* () {
            const v = yield* Queue.take(verdicts)
            const d = deferreds.get(v.call_id)
            if (d !== undefined) yield* Deferred.succeed(d, v)
          }),
        ),
      )

      const resolve: Resolver = (call) => {
        if (!predicate(call)) return Effect.succeed(execute)
        const d = deferreds.get(call.call_id)!
        return Deferred.await(d).pipe(
          Effect.map((v) =>
            v.decision === "approve" ? execute : reject(denied(call, v.reason)),
          ),
        )
      }

      const announce = Stream.fromIterable<ToolEvent>(
        gated.map((call) => ({
          _tag: "ApprovalRequested",
          call_id: call.call_id,
          tool: call.name,
          arguments: call.arguments,
        })),
      )

      return { resolve, announce }
    })

// ---------------------------------------------------------------------------
// `fromApprovalMap` - request-shaped transport.
//
// `approvals` is keyed by `call_id`. A missing entry for a gated call
// means the user didn't decide; we synthesize a `cancelled` output to
// keep history well-formed before the next provider request.
// ---------------------------------------------------------------------------

export type ApprovalMapEntry =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly reason?: string }

export const fromApprovalMap =
  (
    predicate: (call: Items.FunctionCall) => boolean,
    approvals: ReadonlyMap<string, ApprovalMapEntry>,
  ): Resolver =>
  (call) => {
    if (!predicate(call)) return Effect.succeed(execute)
    const v = approvals.get(call.call_id)
    if (v === undefined) return Effect.succeed(reject(cancelled(call)))
    return Effect.succeed(
      v.decision === "approve" ? execute : reject(denied(call, v.reason)),
    )
  }

// ---------------------------------------------------------------------------
// Combinators - compose policy onto an inner resolver.
// ---------------------------------------------------------------------------

/**
 * Authz gate. `canApprove` runs BEFORE the inner resolver; failures
 * short-circuit to a `permission_denied` rejection. Override `onForbidden`
 * if your audit format wants a different kind or reason.
 */
export const withPermissions =
  (
    inner: Resolver,
    canApprove: (call: Items.FunctionCall) => Effect.Effect<boolean>,
    onForbidden: (call: Items.FunctionCall) => Items.FunctionCallOutput = (
      call,
    ) => rejected(call, "permission_denied", "missing permissions"),
  ): Resolver =>
  (call) =>
    canApprove(call).pipe(
      Effect.flatMap((allowed) =>
        allowed ? inner(call) : Effect.succeed(reject(onForbidden(call))),
      ),
    )

/**
 * Fallback gate. If `inner` returns a Reject whose output matches the
 * `recoverable` predicate, run `fallback(call)` instead and use that
 * decision. Otherwise pass the original Reject through untouched.
 */
export const withFallback =
  (
    inner: Resolver,
    recoverable: (output: Items.FunctionCallOutput) => boolean,
    fallback: (call: Items.FunctionCall) => Effect.Effect<ToolDecision>,
  ): Resolver =>
  (call) =>
    inner(call).pipe(
      Effect.flatMap((decision) =>
        decision._tag === "Reject" && recoverable(decision.output)
          ? fallback(call)
          : Effect.succeed(decision),
      ),
    )
