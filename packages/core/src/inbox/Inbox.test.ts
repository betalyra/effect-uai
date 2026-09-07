import { describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Queue } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { drainBurst } from "./Inbox.js"

describe("drainBurst", () => {
  it.effect("resets the window on every arrival, so a burst outlives one settle", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>()
      const burst = yield* Effect.forkChild(drainBurst(queue, "1 second"))

      yield* Queue.offer(queue, "a")
      yield* TestClock.adjust("900 millis")
      yield* Queue.offer(queue, "b")
      yield* TestClock.adjust("900 millis")
      // 1.8s elapsed, more than one settle, and the burst is still open.
      expect(burst.pollUnsafe()).toBeUndefined()

      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(burst)).toEqual(["a", "b"])
    }),
  )

  it.effect("waits for the first item without a deadline", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>()
      const burst = yield* Effect.forkChild(drainBurst(queue, "1 second"))

      yield* TestClock.adjust("1 hour")
      expect(burst.pollUnsafe()).toBeUndefined()

      yield* Queue.offer(queue, "late")
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(burst)).toEqual(["late"])
    }),
  )

  it.effect("ends on the first quiet gap and leaves later items for the next drain", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>()
      const burst = yield* Effect.forkChild(drainBurst(queue, "1 second"))

      yield* Queue.offer(queue, "first")
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(burst)).toEqual(["first"])

      yield* Queue.offer(queue, "second")
      expect(yield* Queue.poll(queue)).toEqual(Option.some("second"))
    }),
  )
})
