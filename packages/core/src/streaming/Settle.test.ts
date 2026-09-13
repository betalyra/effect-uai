import { describe, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Option, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { drainBurst, onQuiet, settleBurst } from "./Settle.js"

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

  it.effect("yields the batch in hand when the queue ends mid-burst", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const burst = yield* Effect.forkChild(drainBurst(queue, "1 second"))

      yield* Queue.offer(queue, "a")
      yield* TestClock.adjust("100 millis")
      yield* Queue.end(queue)
      yield* TestClock.adjust("10 millis")

      expect(yield* Fiber.join(burst)).toEqual(["a"])
    }),
  )

  it.effect("propagates a queue failure rather than treating it as the end", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, string | Cause.Done>()
      const burst = yield* Effect.forkChild(drainBurst(queue, "1 second"))

      yield* Queue.offer(queue, "a")
      yield* TestClock.adjust("100 millis")
      yield* Queue.fail(queue, "boom")
      yield* TestClock.adjust("10 millis")

      const exit = yield* Effect.exit(Fiber.join(burst))
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("boom")
    }),
  )

  it.effect("does not mistake an interrupt mid-burst for the end of the queue", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const burst = yield* Effect.forkChild(drainBurst(queue, "1 second"))

      yield* Queue.offer(queue, "a")
      yield* TestClock.adjust("100 millis")
      yield* Fiber.interrupt(burst)

      // Returning ["a"] here would mean interruption silently looked like a
      // settled burst.
      const exit = yield* Effect.exit(Fiber.join(burst))
      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("settleBurst", () => {
  const collecting = <A>(stream: Stream.Stream<A, never>) =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<A>>([])
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(stream, (a) => Ref.update(seen, (xs) => [...xs, a])),
      )
      return { seen, fiber }
    })

  it.effect("holds a growing burst back, then emits it as one batch", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const { seen } = yield* collecting(Stream.fromQueue(queue).pipe(settleBurst("1 second")))

      yield* Queue.offer(queue, "a")
      yield* TestClock.adjust("900 millis")
      yield* Queue.offer(queue, "b")
      yield* TestClock.adjust("900 millis")
      // Each arrival reset the window, so nothing has been emitted yet.
      expect(yield* Ref.get(seen)).toEqual([])

      yield* TestClock.adjust("1 second")
      expect(yield* Ref.get(seen)).toEqual([["a", "b"]])
    }),
  )

  it.effect("emits the in-flight batch when the source ends mid-burst", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const { seen } = yield* collecting(Stream.fromQueue(queue).pipe(settleBurst("1 second")))

      yield* Queue.offer(queue, "only")
      yield* TestClock.adjust("100 millis")
      yield* Queue.end(queue)
      yield* TestClock.adjust("10 millis")

      expect(yield* Ref.get(seen)).toEqual([["only"]])
    }),
  )

  it.effect("splits bursts on every silence, keeping order across a conversation", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const { seen } = yield* collecting(Stream.fromQueue(queue).pipe(settleBurst("1 second")))

      // Three quick lines, a pause, two more, a pause, then one alone.
      yield* Queue.offer(queue, "hey")
      yield* TestClock.adjust("100 millis")
      yield* Queue.offer(queue, "are you there")
      yield* TestClock.adjust("100 millis")
      yield* Queue.offer(queue, "?")
      yield* TestClock.adjust("2 seconds")

      yield* Queue.offer(queue, "actually")
      yield* TestClock.adjust("100 millis")
      yield* Queue.offer(queue, "never mind")
      yield* TestClock.adjust("2 seconds")

      yield* Queue.offer(queue, "bye")
      yield* TestClock.adjust("2 seconds")

      expect(yield* Ref.get(seen)).toEqual([
        ["hey", "are you there", "?"],
        ["actually", "never mind"],
        ["bye"],
      ])
    }),
  )

  it.effect("fails the stream when the source fails instead of ending quietly", () =>
    Effect.gen(function* () {
      const source: Stream.Stream<string, string> = Stream.make("a").pipe(
        Stream.concat(Stream.fail("boom")),
      )
      const exit = yield* Effect.exit(Stream.runCollect(source.pipe(settleBurst("1 second"))))

      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("boom")
    }),
  )

  it.effect("stops pulling the source while the consumer is blocked", () =>
    Effect.gen(function* () {
      const pulled = yield* Ref.make(0)
      const source = Stream.fromIterable(Array.from({ length: 50 }, (_, i) => i)).pipe(
        Stream.rechunk(1),
        Stream.tap(() => Ref.update(pulled, (n) => n + 1)),
      )
      yield* Effect.forkChild(
        source.pipe(
          settleBurst("1 second", { capacity: 2 }),
          Stream.runForEach(() => Effect.never),
        ),
      )
      yield* TestClock.adjust("10 seconds")

      // An unbounded buffer would have drained all 50 into memory by now.
      expect(yield* Ref.get(pulled)).toBeLessThan(50)
    }),
  )
})

describe("onQuiet", () => {
  const mark = Effect.succeed(Option.some("<quiet>"))

  const collecting = (stream: Stream.Stream<string, never>) =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Effect.forkChild(
        Stream.runForEach(stream, (a) => Ref.update(seen, (xs) => [...xs, a])),
      )
      return seen
    })

  it.effect("passes elements downstream without waiting for the quiet period", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const seen = yield* collecting(Stream.fromQueue(queue).pipe(onQuiet("1 second", mark)))

      yield* Queue.offer(queue, "a")
      yield* TestClock.adjust("10 millis")
      yield* Queue.offer(queue, "b")
      yield* TestClock.adjust("10 millis")

      // Both are downstream well inside the settle window, and no mark yet.
      expect(yield* Ref.get(seen)).toEqual(["a", "b"])
    }),
  )

  it.effect("emits once the source goes quiet, and not again until it speaks", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const seen = yield* collecting(Stream.fromQueue(queue).pipe(onQuiet("1 second", mark)))

      yield* Queue.offer(queue, "a")
      yield* TestClock.adjust("2 seconds")
      expect(yield* Ref.get(seen)).toEqual(["a", "<quiet>"])

      // Still silent: the mark does not repeat while nothing arrives.
      yield* TestClock.adjust("10 seconds")
      expect(yield* Ref.get(seen)).toEqual(["a", "<quiet>"])

      // A new element re-arms it.
      yield* Queue.offer(queue, "b")
      yield* TestClock.adjust("2 seconds")
      expect(yield* Ref.get(seen)).toEqual(["a", "<quiet>", "b", "<quiet>"])
    }),
  )

  it.effect("keeps the window open while elements keep arriving", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const seen = yield* collecting(Stream.fromQueue(queue).pipe(onQuiet("1 second", mark)))

      yield* Queue.offer(queue, "a")
      yield* TestClock.adjust("900 millis")
      yield* Queue.offer(queue, "b")
      yield* TestClock.adjust("900 millis")
      // 1.8s elapsed, but never 1s of silence.
      expect(yield* Ref.get(seen)).toEqual(["a", "b"])

      yield* TestClock.adjust("2 seconds")
      expect(yield* Ref.get(seen)).toEqual(["a", "b", "<quiet>"])
    }),
  )

  it.effect("marks each utterance in a run of speech, pauses and more speech", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const seen = yield* collecting(Stream.fromQueue(queue).pipe(onQuiet("1 second", mark)))

      // Deltas of one sentence, arriving faster than the window.
      for (const token of ["what", " about", " Paris"]) {
        yield* Queue.offer(queue, token)
        yield* TestClock.adjust("200 millis")
      }
      expect(yield* Ref.get(seen)).toEqual(["what", " about", " Paris"])

      // The speaker stops: one mark, and it does not repeat.
      yield* TestClock.adjust("3 seconds")
      // A second sentence re-arms and marks again.
      for (const token of ["in", " winter"]) {
        yield* Queue.offer(queue, token)
        yield* TestClock.adjust("200 millis")
      }
      yield* TestClock.adjust("3 seconds")

      expect(yield* Ref.get(seen)).toEqual([
        "what",
        " about",
        " Paris",
        "<quiet>",
        "in",
        " winter",
        "<quiet>",
      ])
    }),
  )

  it.effect("emits nothing when there is nothing to emit, and waits for the next element", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string, Cause.Done>()
      const emitted = yield* Ref.make(0)
      // Stands in for an accumulator that is already empty.
      const emitIfSecond = Effect.map(
        Ref.updateAndGet(emitted, (n) => n + 1),
        (n) => (n === 1 ? Option.none<string>() : Option.some("<quiet>")),
      )
      const seen = yield* collecting(
        Stream.fromQueue(queue).pipe(onQuiet("1 second", emitIfSecond)),
      )

      yield* Queue.offer(queue, "a")
      yield* TestClock.adjust("3 seconds")
      // First quiet period asked, got None, and stayed silent.
      expect(yield* Ref.get(seen)).toEqual(["a"])
      expect(yield* Ref.get(emitted)).toBe(1)

      // It is disarmed, so silence alone does not ask again.
      yield* TestClock.adjust("10 seconds")
      expect(yield* Ref.get(emitted)).toBe(1)

      yield* Queue.offer(queue, "b")
      yield* TestClock.adjust("3 seconds")
      expect(yield* Ref.get(seen)).toEqual(["a", "b", "<quiet>"])
    }),
  )
})
