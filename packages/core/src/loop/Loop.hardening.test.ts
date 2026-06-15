import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { loop, loopOver, next, stop, value } from "./Loop.js"

// ---------------------------------------------------------------------------
// Phase 1 tests for plans/loop-hardening-spec.md. These pin (and where the
// spec predicts a defect, expose) the behaviours described in Section 4.
// ---------------------------------------------------------------------------

describe("Loop hardening - Issue 4: emit-before-teardown ordering", () => {
  it("leading values are emitted before the iteration scope is finalized", async () => {
    const order: Array<string> = []

    const body = (s: number) =>
      s >= 2
        ? stop()
        : Stream.make(value(`v${s}`)).pipe(
            Stream.concat(next(s + 1)),
            Stream.ensuring(Effect.sync(() => order.push(`close-${s}`))),
            Stream.rechunk(8), // merges [value, next] into ONE chunk -> exercises the bug path
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
})

describe("Loop hardening - Issue 2: scope finalizer accumulation (diagnostic)", () => {
  // Slow/manual: meaningful only with `--expose-gc`. Skipped by default so CI
  // noise doesn't flake; flip to `it` and run with node --expose-gc to measure.
  it.skip("retained memory does not grow with iteration count", async () => {
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
})

describe("Loop hardening - Issue 1: terminal vs order-(non)destroying operators", () => {
  it("order-preserving regrouping keeps values and terminates correctly", async () => {
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

  it.skip("(documented limitation) order-destroying operators may strand post-terminal values", () => {
    // Using Stream.merge / concurrent flatMap / race inside a loop body can place the
    // terminal out of order relative to values, dropping or stranding them. This is a
    // contract violation by the body, not a fixable defect in `loop` (would require
    // moving the decision off the element stream, which we have ruled out). Body authors
    // must keep the terminal as the last element in stream order.
  })
})

describe("Loop hardening - Issue 3: loopOver cross-item state threading", () => {
  it("threads state across input items deterministically", async () => {
    const input = Stream.make("a", "b", "c")
    // body advances state once per item then stops that item's inner loop
    const body = (s: number, _item: string) =>
      Stream.make(value(s)).pipe(Stream.concat(stop(s + 1))) // emit state, advance, next item
    const out = await Effect.runPromise(
      loopOver(input, 0, body).pipe(Stream.runCollect, Effect.map((c) => Array.from(c))),
    )
    expect(out).toEqual([0, 1, 2])
  })
})

describe("Loop hardening - perf baseline (R2)", () => {
  it("loop throughput", async () => {
    const N = 1_000_000
    const body = (s: number) =>
      s >= N ? stop() : Stream.make(value(s)).pipe(Stream.concat(next(s + 1)))

    const t0 = performance.now()
    await Effect.runPromise(loop(0, body).pipe(Stream.runDrain))
    const elapsed = performance.now() - t0
    console.log(`loop throughput: ${(N / (elapsed / 1000)).toFixed(0)} elems/sec`)
    expect(elapsed).toBeGreaterThan(0)
  }, 30_000)
})
