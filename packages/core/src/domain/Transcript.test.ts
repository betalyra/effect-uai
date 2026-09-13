import { describe, it } from "@effect/vitest"
import { Cause, Effect, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { accumulatePartials, type TranscriptEvent } from "./Transcript.js"

const collecting = (stream: Stream.Stream<TranscriptEvent, never>) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<TranscriptEvent>>([])
    yield* Effect.forkChild(Stream.runForEach(stream, (e) => Ref.update(seen, (xs) => [...xs, e])))
    return seen
  })

/** Deltas arriving faster than any settle window. */
const speak = (
  queue: Queue.Queue<TranscriptEvent, Cause.Done>,
  tokens: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.forEach(
    tokens,
    (text) =>
      Effect.andThen(Queue.offer(queue, { _tag: "partial", text }), TestClock.adjust("100 millis")),
    { discard: true },
  )

const opened = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<TranscriptEvent, Cause.Done>()
  const seen = yield* collecting(
    Stream.fromQueue(queue).pipe(accumulatePartials({ silence: "1 second" })),
  )
  return { queue, seen }
})

describe("accumulatePartials", () => {
  it.effect("joins deltas into the running hypothesis, forwarding each as it arrives", () =>
    Effect.gen(function* () {
      const { queue, seen } = yield* opened

      yield* speak(queue, [" Hi", ",", " how"])

      // Three in, three out, each the whole sentence so far, none delayed.
      expect(yield* Ref.get(seen)).toEqual([
        { _tag: "partial", text: "Hi" },
        { _tag: "partial", text: "Hi," },
        { _tag: "partial", text: "Hi, how" },
      ])
    }),
  )

  it.effect("commits on silence and starts the next utterance from empty", () =>
    Effect.gen(function* () {
      const { queue, seen } = yield* opened

      yield* speak(queue, [" Hi", " there"])
      yield* TestClock.adjust("3 seconds")
      yield* speak(queue, [" Bye"])
      yield* TestClock.adjust("3 seconds")

      expect(yield* Ref.get(seen)).toEqual([
        { _tag: "partial", text: "Hi" },
        { _tag: "partial", text: "Hi there" },
        { _tag: "final", text: "Hi there" },
        { _tag: "partial", text: "Bye" },
        { _tag: "final", text: "Bye" },
      ])
    }),
  )

  it.effect("a provider's own final resets the accumulator, so silence adds no duplicate", () =>
    Effect.gen(function* () {
      const { queue, seen } = yield* opened

      yield* speak(queue, [" Hi"])
      yield* Queue.offer(queue, { _tag: "final", text: "Hi." })
      yield* TestClock.adjust("3 seconds")

      expect(yield* Ref.get(seen)).toEqual([
        { _tag: "partial", text: "Hi" },
        { _tag: "final", text: "Hi." },
      ])
    }),
  )

  it.effect("commits the pending text when the stream ends mid-utterance", () =>
    Effect.gen(function* () {
      const { queue, seen } = yield* opened

      yield* speak(queue, [" Half a sen"])
      yield* Queue.end(queue)
      yield* TestClock.adjust("10 millis")

      expect(yield* Ref.get(seen)).toEqual([
        { _tag: "partial", text: "Half a sen" },
        { _tag: "final", text: "Half a sen" },
      ])
    }),
  )
})
