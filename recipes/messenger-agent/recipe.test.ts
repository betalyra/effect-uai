/**
 * The router and the per-conversation loop against the two mocks: what the
 * user sees on the platform (posts, edits, typing) and what the model was
 * asked (one history per conversation).
 */
import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, type Duration, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect"
import * as Image from "@effect-uai/core/Image"
import * as ImageGenerator from "@effect-uai/core/ImageGenerator"
import * as Items from "@effect-uai/core/Items"
import {
  ChannelId,
  type ConversationRef,
  InboundEvent,
  MessageId,
  type Outbound,
  UserId,
} from "@effect-uai/core/Messenger"
import * as MockMessenger from "@effect-uai/core/testing/MockMessenger"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { type Options, imageTool, router } from "./recipe.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const getTime = Tool.make({
  name: "get_time",
  description: "Get the current time for a timezone.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ timezone: Schema.String })),
  run: ({ timezone }) => Effect.succeed({ timezone, iso: "2026-05-04T12:00:00Z" }),
  strict: true,
})

const options: Options = {
  model: "mock",
  toolkit: Toolkit.make(getTime, imageTool("mock-image")),
  system: "Be brief.",
  status: (name) => `<i>${name}…</i>`,
  settle: "20 millis",
}

// Every prompt becomes one URL image, so the post can be traced back to it.
const drawer = Layer.succeed(ImageGenerator.ImageGenerator, {
  generate: ({ prompt }) =>
    Effect.succeed({ images: [{ image: Image.imageUrl(`https://img/${prompt}`) }], usage: {} }),
  edit: () => Effect.die("unused"),
  streamGeneration: () => Stream.die("unused"),
  streamEdit: () => Stream.die("unused"),
})

const usage = { input_tokens: 5, output_tokens: 5, total_tokens: 10 }

const says = (text: string): Turn.Turn => ({
  stop_reason: "stop",
  usage,
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
})

const callsTool = (call_id: string, name: string, args: unknown): Turn.Turn => ({
  stop_reason: "tool_calls",
  usage,
  items: [{ type: "function_call", call_id, name, arguments: JSON.stringify(args) }],
})

const chat = (id: string): ConversationRef => ({ channel: ChannelId(id) })

const said = (conversation: ConversationRef, text: string, addressed = true) =>
  InboundEvent.Message({
    conversation,
    id: MessageId(`in-${text}`),
    author: UserId("u1"),
    text,
    addressed,
    raw: undefined,
  })

const reacted = (conversation: ConversationRef, emoji: string) =>
  InboundEvent.Reaction({
    conversation,
    message: MessageId("m1"),
    emoji,
    author: UserId("u1"),
    raw: undefined,
  })

const bodyOf = (msg: Outbound): string => (msg.body._tag === "Text" ? msg.body.text : "")

const tagged = <T extends MockMessenger.Call["_tag"]>(
  calls: ReadonlyArray<MockMessenger.Call>,
  tag: T,
) => calls.filter((c): c is Extract<MockMessenger.Call, { _tag: T }> => c._tag === tag)

const userTexts = (history: ReadonlyArray<Items.HistoryItem>) =>
  history
    .filter((i): i is Items.Message => i.type === "message" && i.role === "user")
    .flatMap((m) => m.content)
    .filter(Items.isInputText)
    .map((c) => c.text)

/**
 * Run the router over `events` with both mocks. The event stream stays open
 * for `quiet` after the last event, so forked conversations get to finish
 * before the scope closes.
 */
const run = (
  turns: ReadonlyArray<Turn.Turn>,
  events: ReadonlyArray<InboundEvent>,
  quiet: Duration.Input = "150 millis",
) =>
  Effect.gen(function* () {
    const source = yield* Queue.unbounded<InboundEvent>()
    const messenger = MockMessenger.layer({
      events: Stream.fromQueue(source),
      streamOptions: { every: 0, minChars: 1 },
    })
    const provider = MockProvider.layerWithRecorder(turns)

    yield* Effect.gen(function* () {
      const dispatch = yield* Effect.forkScoped(router(options))
      yield* Queue.offerAll(source, events)
      yield* Effect.sleep(quiet)
      yield* Fiber.interrupt(dispatch)
    }).pipe(
      Effect.scoped,
      Effect.provide(messenger.layer),
      Effect.provide(provider.layer),
      Effect.provide(drawer),
    )

    const { calls } = yield* messenger.recorder
    const { calls: asked } = yield* provider.recorder
    return { calls, asked }
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("messenger-agent", () => {
  it.live("streams the answer into one message with typing held for the turn", () =>
    Effect.gen(function* () {
      const { calls, asked } = yield* run(
        [says("It is noon.")],
        [said(chat("a"), "what time is it")],
      )

      expect(userTexts(asked[0]!.history)).toEqual(["what time is it"])
      expect(tagged(calls, "Post").map((p) => bodyOf(p.message))).toEqual(["It is noon."])
      expect(calls.map((c) => c._tag)).toEqual(["TypingStart", "Post", "TypingStop"])
    }),
  )

  it.live("posts a status line for a tool call and no message for a tool-only turn", () =>
    Effect.gen(function* () {
      const { calls, asked } = yield* run(
        [callsTool("c1", "get_time", { timezone: "Europe/Lisbon" }), says("Noon in Lisbon.")],
        [said(chat("a"), "time in lisbon?")],
      )

      expect(tagged(calls, "Post").map((p) => bodyOf(p.message))).toEqual([
        "<i>get_time…</i>",
        "Noon in Lisbon.",
      ])
      // The second turn carried the tool output and did not wait on the inbox.
      expect(asked).toHaveLength(2)
      expect(asked[1]!.history.some((i) => i.type === "function_call_output")).toBe(true)
    }),
  )

  it.live("the image tool posts the picture into the asking conversation", () =>
    Effect.gen(function* () {
      const { calls } = yield* run(
        [callsTool("c1", "generate_image", { prompt: "a cat" }), says("There you go.")],
        [said(chat("a"), "draw a cat")],
      )

      const posts = tagged(calls, "Post")
      const picture = posts.find((p) => p.message.body._tag === "Media")
      expect(picture?.conversation).toEqual(chat("a"))
      expect(picture?.message.body).toMatchObject({ media: { url: "https://img/a cat" } })
      expect(posts.map((p) => bodyOf(p.message))).toEqual([
        "<i>generate_image…</i>",
        "",
        "There you go.",
      ])
    }),
  )

  it.live("the react tool reacts to the last message of the burst it answered", () =>
    Effect.gen(function* () {
      const { calls } = yield* run(
        [callsTool("c1", "react", { emoji: "⭐" }), says("Done.")],
        [said(chat("a"), "star this"), said(chat("a"), "actually this one")],
      )

      expect(tagged(calls, "React")).toMatchObject([
        { emoji: "⭐", message: { conversation: chat("a"), id: "in-actually this one" } },
      ])
    }),
  )

  it.live("answers a reaction in a live chat and stays quiet in a cold one", () =>
    Effect.gen(function* () {
      const { asked } = yield* run(
        [says("hello")],
        [
          said(chat("a"), "hi"),
          reacted(chat("a"), "🤔"),
          // No conversation here, so nothing to answer into.
          reacted(chat("b"), "👍"),
        ],
      )

      // One turn: the reaction lands inside the settle window and joins the
      // burst. Chat b started nothing, so there is no second history.
      expect(asked.map((c) => userTexts(c.history))).toEqual([["hi", "[reacted 🤔]"]])
    }),
  )

  it.live("keeps one loop and one history per conversation, ignoring unaddressed talk", () =>
    Effect.gen(function* () {
      const { calls, asked } = yield* run(
        [says("hi a"), says("hi b")],
        [
          said(chat("a"), "hello from a"),
          said(chat("b"), "lunch?", false),
          said(chat("b"), "hello from b"),
        ],
      )

      const targets = tagged(calls, "Post").map((p) => p.conversation.channel)
      expect(Arr.sort(targets, (x: string, y: string) => (x < y ? -1 : 1))).toEqual(["a", "b"])
      const histories = asked.map((c) => userTexts(c.history))
      expect(histories).toHaveLength(2)
      expect(histories.every((h) => h.length === 1)).toBe(true)
      expect(histories.flat()).not.toContain("lunch?")
    }),
  )

  it.live("greets /start without starting a conversation", () =>
    Effect.gen(function* () {
      const start = InboundEvent.Command({
        conversation: chat("a"),
        name: "start",
        args: "",
        author: UserId("u1"),
        raw: undefined,
      })
      const { calls, asked } = yield* run([], [start])

      expect(tagged(calls, "Post")).toHaveLength(1)
      expect(asked).toEqual([])
    }),
  )
})
