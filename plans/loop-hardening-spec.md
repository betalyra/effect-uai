# `Loop` Hardening Spec — Issues, Tests, and Fixes

**Target file:** `packages/core/src/loop/Loop.ts` (effect-uai)
**Audience:** Claude Code
**Mode:** Test-first. **Write the tests in Phase 1 and run them before changing any production code**, so we can confirm which issues actually reproduce on the current implementation.

---

## 0. Context you need before touching anything

`loop(initial, step)` builds a `Stream<Value>` by repeatedly running `step(state)`, which returns a `Stream<Step<Value, State>>`. The body emits **in-band command steps**:

- `value(a)` → flows downstream
- `next(s)` → end this iteration, continue with new state `s`
- `stop()` / `stopWith(s)` → end the loop (`StopWith` carries a final state used by the sibling helpers)

The driver is a **pull-based `while (true)` loop** inside `Stream.fromPull` (via `Stream.scoped`). Each iteration runs `step(state)` in its own forked scope, pulls chunks of `Step`s, splits leading `value`s from the first terminal (`partitionChunk`), emits the values, applies the terminal, and starts the next iteration. Siblings: `loopOver` (input-driven, threads state across input items), `loopWithState` (exposes a `SubscriptionRef<State>`), `onTurnComplete` (turn-aware body helper).

Helper names below (`value` / `next` / `stop` / `stopWith`) may be exported standalone or namespaced under `loop.*` — **check the actual exports and adjust imports in the tests.**

---

## 1. Non-negotiable requirements (do not violate any of these)

- **R1 — Stream-primitive bodies.** A body must remain `(state) => Stream<Step> | Effect<Stream<Step>>`. Developers must be able to use arbitrary `Stream` combinators inside the body. **Do not** change bodies to `Channel`s or move the decision onto `Channel.OutDone`.
- **R2 — High performance.** Keep the **imperative `while (true)` pull driver** and its mutable cells. **Do not** rewrite it into a recursive `Channel` / recursive `Effect.suspend` / `flatMap`-on-done style. That style was benchmarked as significantly slower here. No new per-element allocations.
- **R3 — Preserve all features and contracts.** `loop`, `loopOver`, `loopWithState`, `onTurnComplete`, `StopWith`, `Effect<Stream>` bodies, dual data-first / data-last signatures. Keep: first-terminal-wins, body-ends-without-terminal ⇒ stop, pull-based backpressure, one active iteration at a time, no background producer fiber, no queue buffering.
- **R4 — Minimal, localized changes.** No architectural refactors. Fix the specific defects only.

### Explicitly forbidden approaches

1. Moving the terminal to `Channel.OutDone` / making the body a `Channel`. (Violates R1.)
2. Recursive `Channel.flatMap(decision => go(state'))` or recursive `return yield* pull` drivers. (Violates R2.)
3. Changing "first terminal in a chunk wins" or "no terminal ⇒ stop". (Violates R3.)

---

## 2. Workflow (in order)

1. **Phase 1 — Tests.** Implement every test in Section 4. Run the suite. **Report which tests fail and which pass.** Expected at this stage: Issue 4 test **fails**; Issue 2 diagnostic shows growth; Issue 1 guard **passes** (it pins already-correct behavior); Issue 1 limitation test is `skip`ped; Issue 3 has no failing test; the perf benchmark establishes a baseline number.
2. **Phase 2 — Fixes.** Apply the fixes in Section 4 for Issue 4 and Issue 2. Issue 3 is a small preventive change. Issue 1 is documentation + a guard (no code fix possible under R1). Issue 5 needs no change.
3. **Phase 3 — Verify.** All guards green, Issue 4 test green, Issue 2 diagnostic flat, **no feature regressions** across `loop`/`loopOver`/`loopWithState`/`onTurnComplete`, and **the perf benchmark within ~5% of the Phase 1 baseline** (R2).

---

## 3. Status at a glance

| Issue | What | Failing test now? | Fix type | Priority |
|---|---|---|---|---|
| 4 | Iteration scope closed *before* its leading values are emitted | **Yes** (with a chunk-merging op) | Code (defer terminal) | High |
| 2 | `Scope.fork(parent)` per iteration accumulates finalizers on the long-lived parent | Diagnostic (heap growth) | Code (root scope) | High for long/unbounded loops |
| 1 | In-band terminal stranded/dropped by **order-destroying** operators | No (inherent limitation) | Docs + contract guard | Medium |
| 3 | `loopOver` threads cross-item state via shared `Ref` + sequential `flatMap` | No (correct under default concurrency) | Code (preventive) | Low |
| 5 | Empty chunks / no-terminal / per-element `Step` wrapping | No (correctness fine) | None (perf note) | None |

---

## 4. Issues, tests, and fixes

### Issue 4 — Emit-before-teardown ordering  *(failing test; fix required)*

**What.** When a single pulled chunk contains leading `value`s **and** a terminal (e.g. `[value(a), value(b), next(s)]`), the driver closes the iteration's scope before returning the leading values:

```ts
// current (buggy) ordering inside the while-loop:
if (Option.isSome(decision)) {
  yield* closeActive(active, Exit.void)   // (1) runs the iteration's finalizers
  /* update state / done */
}
if (isNonEmpty(values)) return values     // (2) emits the values AFTER (1)
```

Any emitted value that references a resource acquired in that iteration's scope is dangling by the time downstream receives it.

**Why it matters under our requirements.** Under normal helper usage (`values.pipe(Stream.concat(next(s)))`) the terminal lands in its *own* chunk, so this path is not hit. But a developer using stream primitives like `Stream.rechunk` / `Stream.buffer` in the body (which R1 explicitly allows) can merge the values and the terminal into one chunk and trigger it. So it is in scope.

**Test (fails on current code).** Force the same-chunk case with `Stream.rechunk`, register an iteration-scoped finalizer, and assert each value is delivered *before* its iteration closes:

```ts
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
// import { loop, value, next, stop } from "../src/loop/Loop.js"  // adjust to real exports

it("Issue 4: leading values are emitted before the iteration scope is finalized", async () => {
  const order: Array<string> = []

  const body = (s: number) =>
    s >= 2
      ? stop()
      : Stream.make(value(`v${s}`)).pipe(
          Stream.concat(next(s + 1)),
          Stream.ensuring(Effect.sync(() => order.push(`close-${s}`))),
          Stream.rechunk(8), // merges [value, next] into ONE chunk → exercises the bug path
        )

  await Effect.runPromise(
    loop(0, body).pipe(
      Stream.tap((v) => Effect.sync(() => order.push(`recv-${v}`))),
      Stream.runDrain,
    ),
  )

  // value must reach downstream before its iteration's finalizer runs
  expect(order.indexOf("recv-v0")).toBeLessThan(order.indexOf("close-0"))
  expect(order.indexOf("recv-v1")).toBeLessThan(order.indexOf("close-1"))
  // Pre-fix: close-{s} precedes recv-v{s}. Post-fix: recv-v{s} precedes close-{s}.
})
```

**Fix (defer the terminal; keep `while (true)`).** Add one mutable cell and apply the terminal *after* the chunk's leading values have been returned — on the next pull, before opening the next iteration.

1. Alongside `state` / `current` / `done`, add:
   ```ts
   let pendingTerminal: Step<Value, State> | undefined
   ```
2. At the **top** of the `while (true)` loop, before the `done` check, drain a pending terminal — this becomes the single place that closes the iteration and advances state:
   ```ts
   if (pendingTerminal !== undefined) {
     const t = pendingTerminal
     pendingTerminal = undefined
     if (current !== undefined) yield* closeActive(current, Exit.void)
     if (t._tag === "Stop" || t._tag === "StopWith") done = true
     else state = t.state // Next
     continue
   }
   ```
3. Replace the decision block so it **defers** instead of applying inline:
   ```ts
   if (Option.isSome(decision)) {
     pendingTerminal = decision.value
     if (isNonEmpty(values)) return values // emit now (scope still open); apply terminal next pull
     continue                              // no leading values: top-of-loop applies it immediately
   }
   if (isNonEmpty(values)) return values
   ```

**Notes / regressions to avoid.**
- The existing `Scope.addFinalizerExit(outerScope, …)` still closes `current` on teardown if a `pendingTerminal` is outstanding — keep it.
- `loopOver` / `loopWithState` state capture happens via `Stream.tap` on `Next`/`StopWith` steps as they pass through the body stream (upstream of `Stream.toChannel`), i.e. at *pull* time, independent of when the scope closes. Deferring `closeActive` does not change that — **do not** modify those wrappers.
- The `chunk === undefined` (body completed via `Cause.Done`) path is already correct (no un-emitted values pending there). Leave it.

---

### Issue 2 — `Scope.fork` accumulation across iterations  *(diagnostic; fix recommended)*

**What.** Each iteration does `Scope.fork(outerScope)` and later `Scope.close(child)`. Forking registers a finalizer in the long-lived `outerScope`; closing the child early does **not** remove that entry. Over a long-running loop, `outerScope`'s finalizer set grows O(iterations) — the resources release promptly, but the references accumulate until the whole loop ends.

**Why it matters.** Negligible for short loops (an agent doing tens of turns). Real for long-lived agents and `loopOver` over large input streams.

**Confidence / verification.** This is the expected behavior but there is no crisp public-API assertion for it. Use the heap diagnostic below (run with `--expose-gc`). Pre-fix it should trend ~linear in `N`; post-fix it should stay flat. Confirm with a heap snapshot/profiler if you want certainty before changing code.

**Diagnostic test.**

```ts
it("Issue 2 (diagnostic): retained memory does not grow with iteration count", async () => {
  const N = 200_000
  const body = (s: number) =>
    s >= N ? stop() : Stream.make(value(s)).pipe(Stream.concat(next(s + 1)))

  globalThis.gc?.()
  const before = process.memoryUsage().heapUsed
  await Effect.runPromise(loop(0, body).pipe(Stream.runDrain))
  globalThis.gc?.()
  const after = process.memoryUsage().heapUsed

  const perIteration = (after - before) / N
  // Indicative, not exact. Pre-fix: grows with N. Post-fix: near zero.
  expect(perIteration).toBeLessThan(8) // bytes/iteration; tune threshold to your runtime
})
```

(Mark this slow/manual if it's noisy in CI; the structural fix below is the real remedy.)

**Fix (give each iteration a root scope; lean on the existing teardown finalizer).**

```ts
// where the iteration scope is created:
// before: const bodyScope = yield* Scope.fork(outerScope)
const bodyScope = yield* Scope.make() // root scope — no back-reference into outerScope
const bodyPull = yield* Channel.toPullScoped(Stream.toChannel(stream), bodyScope)
  .pipe(Effect.onError((cause) => Scope.close(bodyScope, Exit.failCause(cause))))
current = { scope: bodyScope, pull: bodyPull }
```

A closed root scope leaves nothing behind in `outerScope`, so nothing accumulates. The one-time `Scope.addFinalizerExit(outerScope, … closeActive(current) …)` still closes the active iteration on teardown/interruption.

**Caveat to honor.** `fork` gave defense-in-depth (the parent closes any forgotten child). With `make`, **every** exit path must close the iteration scope. The current code already routes terminal, error (`onError`), `Cause.Done` (`catchIf`), and teardown through `closeActive` — verify that remains exhaustive after the Issue 4 change (the `pendingTerminal` path closes via the top-of-loop handler; teardown via the finalizer).

---

### Issue 1 — In-band terminal vs order-destroying operators  *(no code fix under R1; document + guard)*

**What.** The terminal is a stream element. Operators that **destroy order** in a body can move it or strand values after it: `Stream.merge` / `mergeAll`, `Stream.flatMap` / `mapEffect` with `concurrency > 1`, `race`. A `next`/`stop` can then appear before values that arrive in a *later* chunk belonging to an already-terminated iteration — unrecoverable.

**Important nuance.** **Order-preserving** regroupers (`rechunk`, `buffer`, `groupedWithin`) are fine: they keep the terminal after the values that precede it in stream order. Only order-destroying operators break the model.

**Why there is no code fix here.** The only categorical fix is moving the decision off the element stream (`Channel.OutDone`), which R1 forbids. So this is a **contract**, not a bug to patch.

**Action 1 — guard the supported behavior (this test passes today; keep it green):**

```ts
it("Issue 1: order-preserving regrouping keeps values and terminates correctly", async () => {
  const body = (s: number) =>
    s >= 3
      ? stop()
      : Stream.make(value(s * 10), value(s * 10 + 1)).pipe(
          Stream.concat(next(s + 1)),
          Stream.rechunk(1), // order-preserving: must NOT drop values or misplace the terminal
        )

  const out = await Effect.runPromise(
    loop(0, body).pipe(Stream.runCollect, Effect.map((c) => Array.from(c))),
  )
  expect(out).toEqual([0, 1, 10, 11, 20, 21])
})
```

**Action 2 — document the limitation as a skipped test (executable documentation):**

```ts
it.skip("Issue 1 (documented limitation): order-destroying operators may strand post-terminal values", () => {
  // Using Stream.merge / concurrent flatMap / race inside a loop body can place the
  // terminal out of order relative to values, dropping or stranding them. This is a
  // contract violation by the body, not a fixable defect in `loop` (would require
  // moving the decision off the element stream, which we have ruled out). Body authors
  // must keep the terminal as the last element in stream order.
})
```

**Action 3 — add this rule to the body-author docs / `loop` JSDoc:** *"The terminal (`next`/`stop`) must be the last element in the body's stream order. Order-preserving operators (`rechunk`, `buffer`, `groupedWithin`) are safe; order-destroying operators (`merge`, `mergeAll`, concurrent `flatMap`/`mapEffect`, `race`) are not supported across the terminal."*

---

### Issue 3 — `loopOver` cross-item state threading  *(preventive; no failing test)*

**What.** `loopOver` threads state across input items through a shared `Ref` (`stateRef`) read at each item's start and written by a `Stream.tap` on `Next`/`StopWith`, inside `Stream.flatMap` over the input. It's correct **only because** `Stream.flatMap` defaults to `concurrency: 1`. Adding concurrency or a buffering/interleaving operator would race the `Ref`.

**Why there's no failing test.** It's correct under the current default, so nothing reproduces today. The risk is future modification.

**Fix (preventive, minimal — pick one):**
- **Cheap:** pass `{ concurrency: 1 }` explicitly to the `loopOver` `Stream.flatMap` so the sequential requirement can't be silently lost to a default change, and add a comment stating that cross-item state threading requires sequential execution.
- **Stronger (optional, larger):** remove the shared `Ref` by threading the cross-item state explicitly (e.g. express the outer iteration through the input cursor rather than a side `Ref`). Only do this if it stays within R4; otherwise prefer the cheap option.

**Regression guard (keep green):**

```ts
it("Issue 3: loopOver threads state across input items deterministically", async () => {
  const input = Stream.make("a", "b", "c")
  // body advances state once per item then stops that item's inner loop
  const body = (s: number, _item: string) =>
    Stream.make(value(s)).pipe(Stream.concat(stop())) // emit state, advance to next item
  // NOTE: adjust to loopOver's exact "next vs stop" semantics; the assertion is that
  // the final state reflects every item processed in order, with no gaps/dupes.
  const out = await Effect.runPromise(
    loopOver(input, 0, body).pipe(Stream.runCollect, Effect.map((c) => Array.from(c))),
  )
  expect(out).toEqual([0, 1, 2]) // adjust to actual per-item advancement semantics
})
```

---

### Issue 5 — Empty chunks / no-terminal / per-element wrapping  *(non-issue; perf note only)*

**Status: correctness is fine.** Empty chunks loop and re-pull; a body that ends without a terminal maps to stop; terminal-only chunks advance. The only residue is the per-element cost of wrapping every value in `Step.Value` and unwrapping it in `partitionChunk` — inherent to the in-band design and only removable via `Channel.OutDone` (forbidden under R1). **No change required.** Do not "optimize" this by changing the body contract.

---

## 5. Performance guard (protects R2)

Run before and after the fixes; report both numbers. The fixes must not regress throughput beyond ~5%.

```ts
it("perf baseline: loop throughput", async () => {
  const N = 1_000_000
  const body = (s: number) =>
    s >= N ? stop() : Stream.make(value(s)).pipe(Stream.concat(next(s + 1)))

  const t0 = performance.now()
  await Effect.runPromise(loop(0, body).pipe(Stream.runDrain))
  const elapsed = performance.now() - t0
  console.log(`loop throughput: ${(N / (elapsed / 1000)).toFixed(0)} elems/sec`)
  expect(elapsed).toBeGreaterThan(0)
})
```

---

## 6. Definition of done

- Phase 1 ran and the failing/passing breakdown was reported (Issue 4 fails, Issue 1 guard passes, Issue 2 diagnostic shows growth, Issue 3 guard passes, perf baseline recorded).
- Issue 4 fixed via `pendingTerminal`; its test now passes.
- Issue 2 fixed via root `Scope.make()`; diagnostic flat; resource release still exhaustive on all exit paths.
- Issue 1 documented (JSDoc + skipped limitation test); order-preserving guard green.
- Issue 3 hardened (explicit sequential concurrency or explicit threading); guard green.
- No feature regressions in `loop` / `loopOver` / `loopWithState` / `onTurnComplete`.
- Perf benchmark within ~5% of baseline. No body became a `Channel`; the driver is still the imperative `while (true)` loop.
