import { Effect, Schedule, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { next, value } from "@effect-uai/core/Loop"
import { loopFrom, settleBurst } from "./streamOps.js"

// ---------------------------------------------------------------------------
// loopFrom
// ---------------------------------------------------------------------------

describe("loopFrom", () => {
  it("emits body values for each input, threading state", async () => {
    const result = await Effect.runPromise(
      Stream.fromIterable([1, 2, 3]).pipe(
        loopFrom(0, (state, input) =>
          Stream.fromIterable([value(state + input), next(state + input)]),
        ),
        Stream.runCollect,
      ),
    )

    // input=1, state=0 → emit 1, transition to 1
    // input=2, state=1 → emit 3, transition to 3
    // input=3, state=3 → emit 6, transition to 6
    expect(result).toEqual([1, 3, 6])
  })

  it("ends when input stream ends", async () => {
    const result = await Effect.runPromise(
      Stream.fromIterable(["a"]).pipe(
        loopFrom("init", (state, input) =>
          Stream.fromIterable([value(`${state}-${input}`), next(`${state}-${input}`)]),
        ),
        Stream.runCollect,
      ),
    )

    expect(result).toEqual(["init-a"])
  })

  it("body emitting multiple values per input", async () => {
    const result = await Effect.runPromise(
      Stream.fromIterable([1, 2]).pipe(
        loopFrom(0, (state, input) =>
          Stream.fromIterable([
            value(state * 10 + input),
            value(state * 10 + input + 100),
            next(state + input),
          ]),
        ),
        Stream.runCollect,
      ),
    )

    // input=1, state=0 → emit 1, 101, → state=1
    // input=2, state=1 → emit 12, 112, → state=3
    expect(result).toEqual([1, 101, 12, 112])
  })
})

// ---------------------------------------------------------------------------
// settleBurst — resetting-window debounce semantics
// ---------------------------------------------------------------------------

describe("settleBurst", () => {
  it("ends cleanly when input ends (single item)", async () => {
    const result = await Effect.runPromise(
      Stream.fromIterable(["x"]).pipe(settleBurst("50 millis"), Stream.runCollect),
    )
    // Single item: first take gets "x", race times out 50ms later, emit ["x"].
    // Input is exhausted, queue ends, next drain blocks on take → fails with
    // Done → stream ends.
    expect(result).toEqual([["x"]])
  })

  it("coalesces items that arrive in rapid succession", async () => {
    // All three arrive synchronously from `fromIterable`. They land in the
    // queue back-to-back, well before 50ms. drainOne's race always sees
    // an item win, so it keeps collecting until the queue ends, then emits
    // the whole batch.
    const result = await Effect.runPromise(
      Stream.fromIterable(["a", "b", "c"]).pipe(settleBurst("50 millis"), Stream.runCollect),
    )
    expect(result).toEqual([["a", "b", "c"]])
  })

  it("two bursts separated by silence emit as two batches", async () => {
    // Each `delayMs` is the INTER-ITEM gap (sleep before emitting this item),
    // since `Stream.mapEffect` runs sequentially. So:
    //   a: t=0
    //   b: t=10   (10ms after a)
    //   c: t=130  (120ms after b — exceeds 50ms settle → flushes burst 1)
    //   d: t=140  (10ms after c)
    const producer = Stream.fromIterable<readonly [string, number]>([
      ["a", 0],
      ["b", 10],
      ["c", 120],
      ["d", 10],
    ]).pipe(
      Stream.mapEffect(([item, delayMs]) =>
        Effect.sleep(`${delayMs} millis`).pipe(Effect.as(item)),
      ),
    )

    const result = await Effect.runPromise(
      producer.pipe(settleBurst("50 millis"), Stream.runCollect),
    )

    expect(result).toEqual([
      ["a", "b"],
      ["c", "d"],
    ])
  })

  it("resetting-window semantics: items arriving every 30ms within a 50ms window stay in one batch", async () => {
    // Five items, each 30ms apart. With a resetting window (settle=50ms),
    // each new arrival resets the timer → all five end up in one batch.
    // With a FIXED window (Stream.groupedWithin), the first burst would
    // close after ~50ms (1-2 items) and the rest would land in a second batch.
    const producer = Stream.range(1, 5).pipe(Stream.schedule(Schedule.spaced("30 millis")))

    const result = await Effect.runPromise(
      producer.pipe(settleBurst("50 millis"), Stream.runCollect),
    )

    // Each item is < 50ms after the previous → window keeps resetting →
    // one batch with all five items.
    expect(result).toEqual([[1, 2, 3, 4, 5]])
  })
})
