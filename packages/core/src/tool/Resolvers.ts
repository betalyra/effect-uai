/**
 * Ready-made `Resolver`s for the two transport flavors plus combinators
 * for layering policy on top.
 *
 *   - `fromVerdictQueue` : long-lived channel (WebSocket / SSE).
 *   - `fromApprovalMap`  : request-shaped (HTTP chat).
 *   - `withPermissions`  : authz wrapper.
 *   - `withFallback`     : recovery wrapper.
 *
 * None of these know about the executor's stream shape; they just produce
 * `Effect<ToolDecision>`s a `Resolver` can return.
 */
import { Deferred, Effect, Queue, Scope, Stream } from "effect"
import type { FunctionCall } from "../domain/Items.js"
import {
  type ToolDecision,
  type ToolResult,
  cancelled,
  denied,
  execute,
  reject,
  rejected,
} from "./Outcome.js"
import type { Resolver } from "./Toolkit.js"
import type { ToolEvent } from "./ToolEvent.js"

// ---------------------------------------------------------------------------
// Verdict queue (WebSocket-style transport).
// ---------------------------------------------------------------------------

export interface Verdict {
  readonly call_id: string
  readonly decision: "approve" | "deny"
  readonly reason?: string
}

/**
 * Queue-backed resolver. The router fiber drains verdicts and resolves
 * pre-registered Deferreds keyed by `call_id`. Returns the resolver and
 * a stream of `ApprovalRequested` events for the gated calls; the recipe
 * merges the announce stream into its consumer view.
 */
export const fromVerdictQueue =
  (
    predicate: (call: FunctionCall) => boolean,
    verdicts: Queue.Dequeue<Verdict>,
  ) =>
  (
    calls: ReadonlyArray<FunctionCall>,
  ): Effect.Effect<
    {
      readonly resolve: Resolver
      readonly announce: Stream.Stream<ToolEvent>
    },
    never,
    Scope.Scope
  > =>
    Effect.gen(function* () {
      const gated = calls.filter(predicate)

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
// Approval map (HTTP-style transport). Verdicts arrive synchronously
// bundled in the request payload. Missing entries → cancelled.
// ---------------------------------------------------------------------------

export type ApprovalMapEntry =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly reason?: string }

export const fromApprovalMap =
  (
    predicate: (call: FunctionCall) => boolean,
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
    canApprove: (call: FunctionCall) => Effect.Effect<boolean>,
    onForbidden: (call: FunctionCall) => ToolResult = (call) =>
      rejected(call, "permission_denied", "missing permissions"),
  ): Resolver =>
  (call) =>
    canApprove(call).pipe(
      Effect.flatMap((allowed) =>
        allowed ? inner(call) : Effect.succeed(reject(onForbidden(call))),
      ),
    )

/**
 * Fallback gate. If `inner` returns a Reject whose result matches the
 * `recoverable` predicate, run `fallback(call)` instead and use that
 * decision. Otherwise pass the original Reject through.
 */
export const withFallback =
  (
    inner: Resolver,
    recoverable: (result: ToolResult) => boolean,
    fallback: (call: FunctionCall) => Effect.Effect<ToolDecision>,
  ): Resolver =>
  (call) =>
    inner(call).pipe(
      Effect.flatMap((decision) =>
        decision._tag === "Reject" && recoverable(decision.result)
          ? fallback(call)
          : Effect.succeed(decision),
      ),
    )

