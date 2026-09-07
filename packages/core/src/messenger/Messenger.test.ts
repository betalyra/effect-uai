import { describe, it } from "@effect/vitest"
import { Array as Arr, Duration, Effect, Result, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import * as MockMessenger from "../testing/MockMessenger.js"
import {
  ChannelId,
  type ConversationRef,
  MessageId,
  type Outbound,
  type StreamViaEditsOptions,
  inConversation,
  splitForLimit,
} from "./Messenger.js"
import { MessengerRateLimited } from "./MessengerError.js"

const here: ConversationRef = { channel: ChannelId("c1") }

const bodyOf = (msg: Outbound): string => (msg.body._tag === "Text" ? msg.body.text : "")

const posts = (calls: ReadonlyArray<MockMessenger.Call>) =>
  Arr.filterMap(calls, (c) =>
    c._tag === "Post" ? Result.succeed(bodyOf(c.message)) : Result.failVoid,
  )

const edits = (calls: ReadonlyArray<MockMessenger.Call>) =>
  Arr.filterMap(calls, (c) =>
    c._tag === "Edit" ? Result.succeed(bodyOf(c.next)) : Result.failVoid,
  )

/** Run `deltas` through the mock's `stream` and hand back the call log. */
const streamed = (deltas: ReadonlyArray<string>, script: MockMessenger.MockMessengerScript = {}) =>
  Effect.gen(function* () {
    const { service, recorder } = MockMessenger.make(script)
    const id = yield* service.stream(Stream.fromIterable(deltas))
    const { calls } = yield* recorder
    return { id, calls }
  }).pipe(inConversation(here))

const options = (o: StreamViaEditsOptions): MockMessenger.MockMessengerScript => ({
  streamOptions: o,
})

// ---------------------------------------------------------------------------
// splitForLimit
// ---------------------------------------------------------------------------

describe("splitForLimit", () => {
  it("prefers a paragraph break, then a line, then a word", () => {
    expect(splitForLimit("aaa\n\nbbb ccc", 8)).toEqual(["aaa", "bbb ccc"])
    expect(splitForLimit("aaa\nbbbb ccc", 8)).toEqual(["aaa", "bbbb ccc"])
    expect(splitForLimit("aaaa bbbb ccc", 9)).toEqual(["aaaa", "bbbb ccc"])
  })

  it("hard-cuts a run with no boundary inside the limit", () => {
    expect(splitForLimit("aaaaaaaaaa", 4)).toEqual(["aaaa", "aaaa", "aa"])
  })
})

// ---------------------------------------------------------------------------
// streamViaEdits
// ---------------------------------------------------------------------------

describe("streamViaEdits", () => {
  // TestClock keeps wall time frozen, so the `every` gate never opens and
  // every delta after the first coalesces into the final flush.
  it.effect("coalesces deltas arriving inside the `every` window", () =>
    Effect.gen(function* () {
      const { calls } = yield* streamed(["Hel", "lo ", "the", "re!"])

      expect(posts(calls)).toEqual(["Hel"])
      expect(edits(calls)).toEqual(["Hello there!"])
    }),
  )

  it.effect("waits for `minChars` of growth before spending an edit", () =>
    Effect.gen(function* () {
      const { calls } = yield* streamed(
        ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff"],
        options({ every: 0, minChars: 10 }),
      )

      // Edits land at 16 chars (12 of growth) and again on the final flush.
      expect(posts(calls)).toEqual(["aaaa"])
      expect(edits(calls).map((t) => t.length)).toEqual([16, 24])
    }),
  )

  it.effect("skips the final flush when the message already shows the text", () =>
    Effect.gen(function* () {
      const { calls } = yield* streamed(
        ["aaaaa", "bbbbb", "ccccc"],
        options({ every: 0, minChars: 10 }),
      )

      // The third delta opens the growth gate, so the tail is already sent.
      expect(edits(calls)).toEqual(["aaaaabbbbbccccc"])
    }),
  )

  it.effect("rolls over to a new message past maxText", () =>
    Effect.gen(function* () {
      const { id, calls } = yield* streamed(["aaaa bbbb cccc dddd"], {
        limits: { maxText: 10, maxCaption: 10 },
      })

      // Cut on the word boundary, not mid-word, and the id is the last message.
      expect(posts(calls)).toEqual(["aaaa bbbb", "cccc dddd"])
      expect(edits(calls)).toEqual([])
      expect(id).toBe(MessageId("m2"))
    }),
  )

  it.live("waits out a rate limit and re-sends the same edit", () =>
    Effect.gen(function* () {
      const limited = new MessengerRateLimited({
        provider: "mock",
        retryAfter: Duration.millis(10),
      })
      const { calls } = yield* streamed(["abc", "defghij"], {
        ...options({ every: 0, minChars: 1 }),
        failures: [undefined, limited],
      })

      expect(posts(calls)).toEqual(["abc"])
      expect(edits(calls)).toEqual(["abcdefghij", "abcdefghij"])
    }),
  )

  it.effect("gives up once the rate-limit budget is spent", () =>
    Effect.gen(function* () {
      const limited = new MessengerRateLimited({ provider: "mock", retryAfter: Duration.zero })
      const failed = yield* Effect.flip(
        streamed(["abc"], { ...options({ rateLimitRetries: 1 }), failures: [limited, limited] }),
      )

      expect(failed._tag).toBe("MessengerRateLimited")
    }).pipe(TestClock.withLive),
  )
})
