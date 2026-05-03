# Spike — partitioned tool execution + history reconciliation

Exploring how to slim down the `tool-call-approval` recipe (and any future
recipe that mixes safe + gated tool execution) without baking policy into
the framework. Nothing here is shipped — `packages/core/src/tool/Toolkit.ts`
stays untouched until we pick a direction.

## Problem statement

Every recipe that handles HITL, sub-agent delegation, per-tool timeouts,
or per-arg policy ends up writing the same five lines:

```ts
const gated = calls.filter(isSensitive)
const safe  = calls.filter((c) => !isSensitive(c))
const safeOutputs  = yield* Toolkit.executeAllSafe(toolkit, safe)
const gatedOutputs = yield* doSomethingWith(gated)
const outputs      = [...safeOutputs, ...gatedOutputs]
```

Plus the announce-event-before-the-wait dance, plus the denial-output
synthesis. Together, ~30 lines of boilerplate per recipe. Question:
which slice of this is genuinely reusable?

A second, **broader** invariant surfaces in the same area: every
multi-turn flow must guarantee that no `function_call` in `history` is
missing its `function_call_output` before the next provider request.
Without HITL the loop maintains this trivially (it pairs calls with
outputs in the same iteration). With HITL, restarts, follow-ups, or
timeouts the gap can open and the next provider call 400s. So we likely
want a small primitive to **detect** unanswered calls regardless of the
policy used to **resolve** them.

## Options for the partition primitive

### Option A — Lean: just promote `partition`, `deny`, `cancelled`

Add three small helpers to `Toolkit.ts`. No new abstraction.

```ts
Toolkit.partition(calls, predicate): { safe, gated }
Toolkit.deny(call, reason?):      FunctionCallOutput
Toolkit.cancelled(call, reason?): FunctionCallOutput
```

**Pros:** zero opinions; standardizes the denial/cancellation payload
shapes (which the model parses, so consistency matters across recipes);
trivial to implement, document, and test.

**Cons:** doesn't reduce LOC much (~10). Recipes still write the
parallel-execute + result-merging glue themselves.

### Option B — Bundled: `executePartitioned`

```ts
Toolkit.executePartitioned(toolkit, calls, {
  predicate,
  onGated:  (calls) => Effect<Outputs>,
  onSafe?:  (toolkit, calls) => Effect<Outputs>,  // default: executeAllSafe
}): Effect<ReadonlyArray<FunctionCallOutput>>
```

Runs the two paths in parallel (safe doesn't wait on gated).
`onGated` is just an Effect — the user writes whatever (queue, latch,
service, throwing a tagged error, calling out to a Layer). The framework
stays out of policy.

**Pros:** ~20 LOC savings per recipe; the most common shape becomes a
one-liner; runs safe + gated concurrently for free.

**Cons:** the announce-event step (custom event emitted *before* the
wait, so downstream sees it immediately) still belongs in the recipe
because it returns `Effect`, not `Stream`. The recipe still threads the
verdict shape and queue type. So it's a structural helper, not a turnkey
HITL primitive. (Which is what we want.)

### Option C — `Tool.requiresApproval` field — REJECT

```ts
Tool.make({ ..., requiresApproval: (input) => boolean })
```

Vercel-flavored. Bakes policy into tool definitions; the same tool used
in two apps with different approval thresholds becomes awkward (you'd
either define two tools or pass a context arg). Conflates tool *shape*
(what arguments? what does it return?) with tool *policy* (when is this
sensitive?). Skip. Could revisit as an *advisory hint* recipes can
override, but that's a footgun without rigorous defaults.

### Option D — `executeWithGates(toolkit, calls, gates: Gate[])` — REJECT

```ts
type Gate<R> = {
  predicate: (call) => boolean
  resolve:   (calls) => Effect<Outputs, never, R>
}
```

Multiple named gates per turn (admin-approve vs user-confirm vs auto-run).
Premature; no recipe needs more than one gate yet, and once we do, you
just chain two `executePartitioned` calls.

### Option E — Effect-native gate as a Service / Layer

```ts
class ApprovalGate extends Effect.Service<ApprovalGate>()("ApprovalGate", {
  succeed: {
    request: (calls: FunctionCall[]) =>
      Effect<ReadonlyArray<Verdict>, ApprovalError, never>,
  },
}) {}
```

The body asks for approval without knowing how it's resolved:

```ts
const gate = yield* ApprovalGate
const verdicts = yield* gate.request(gatedCalls)
```

The recipe provides the Layer (queue-backed for live, fail-fast for HTTP,
auto-deny for tests, etc.).

**Pros:** maximally Effect-native; layer composition; trivial to swap
implementations in tests; multiple recipes can share the same service
type.

**Cons:** more ceremony for the simple case; recipe authors who haven't
written a Service before have a new concept to learn. Probably the right
shape for a future `@effect-uai/hitl` package, but heavyweight as a v1
primitive.

## Recommendation

**Ship Option A + Option B together.**

- `Toolkit.partition`, `Toolkit.deny`, `Toolkit.cancelled` standardize
  the denial-output shapes (model-facing JSON the user shouldn't have to
  invent) and document the partition pattern.
- `Toolkit.executePartitioned` is the structural one-liner.

Recipes that want more decoupling can ignore `executePartitioned` and
roll their own ApprovalGate Service (Option E). We don't need to ship E
to enable it — anyone can write it on top of the lean helpers.

## The unanswered-calls invariant

Independent of the partition story, every multi-turn loop should be able
to ask: "given this `history`, are there `function_call`s without
matching `function_call_output`s?" Three places this matters:

1. Loop interruption mid-turn (process crash, scope abort): orphan
   function_calls in the persisted history.
2. HTTP/stateful resume: the server hydrates a checkpoint and must
   verify it before submitting.
3. HITL follow-ups: user POSTs a new message while approvals were
   pending; the server must reconcile (synthesize cancellations) before
   adding the user message.

Proposed primitive (in `Items.ts`):

```ts
export const findUnansweredCalls = (
  history: ReadonlyArray<Item>,
): ReadonlyArray<FunctionCall>
```

Plus a sibling helper for the HITL path:

```ts
// In Toolkit.ts
export const cancelAllPending = (
  history: ReadonlyArray<Item>,
  reason?: string,
): ReadonlyArray<FunctionCallOutput>
```

…which is just `findUnansweredCalls(history).map((c) => Toolkit.cancelled(c, reason))`.

## Files in this spike

- `option-b.ts` — implementation of Option B + the small helpers from A.
- `option-b.test.ts` — tests for the partition primitive.
- `history-check.ts` — `findUnansweredCalls` + companion tests.

Run tests:

```sh
pnpm test
```

(Spike tests are auto-discovered via `experiments/*/**/*.test.ts` in the
root `vitest.config.ts`.)

## LOC delta on the recipe — illustrative

What the live `tool-call-approval` recipe loop body looks like with the
spike primitives. Compare against
[`recipes/tool-call-approval/index.ts`](../../recipes/tool-call-approval/index.ts)
lines 140–237.

```ts
// Inside loop((state) => …):
streamUntilComplete<State, ApprovalEvent>((turn) =>
  Effect.sync(() => {
    const next = Turn.cursor(state, turn)
    const calls = Turn.functionCalls(turn)
    if (calls.length === 0) return stop

    // Announce stays in the recipe — the custom event shape is policy.
    const sensitive = calls.filter(isSensitive)
    const announce = Stream.fromIterable<AwaitingApproval>(
      sensitive.length > 0 ? [{ type: "awaiting_approval", calls: sensitive }] : []
    )

    const continuation = Stream.unwrap(Effect.gen(function* () {
      const outputs = yield* Toolkit.executePartitioned(toolkit, calls, {
        predicate: isSensitive,
        onGated: (gated) => Effect.gen(function* () {
          const required = new Set(gated.map((c) => c.call_id))
          const byId = yield* collectVerdicts(verdicts, required)
          return yield* Effect.forEach(gated, (call) => {
            const v = byId.get(call.call_id)!
            return v.decision === "approve"
              ? Toolkit.executeOne(toolkit, call).pipe(
                  Effect.catchTag("ToolError", (err) =>
                    Effect.succeed(Toolkit.defaultRepair(err, call))
                  )
                )
              : Effect.succeed(Toolkit.deny(call, v.reason))
          }, { concurrency: "unbounded" })
        }),
      })
      return nextAfter(Stream.fromIterable<ApprovalEvent>(outputs), {
        ...next,
        history: [...next.history, ...outputs],
      })
    }))

    return Stream.concat(
      Stream.map(announce, (a) => loopValue<ApprovalEvent>(a)),
      continuation,
    )
  })
)
```

What the spike eliminated:

- the manual `denied` helper (the recipe used a custom JSON shape that
  `Toolkit.deny` now standardizes)
- explicit partition into `safe` / `sensitive` arrays + parallel
  `executeAllSafe` + result-merging
- a separate `resolveSensitive` function (now inline as `onGated`)

What stayed — genuine policy, would survive any abstraction:

- verdict shape + queue drain (`collectVerdicts`)
- `AwaitingApproval` event type + announce-then-resolve stream timing
- history threading via `Turn.cursor` + `nextAfter`

Net: ~30 lines off a ~98-line loop body. The remaining lines are all
seams the recipe author wants explicit control over.
