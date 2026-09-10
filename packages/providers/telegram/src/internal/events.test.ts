import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { type BotIdentity, Update, toEvents } from "./events.js"

const bot: BotIdentity = { id: 42, username: "HelperBot" }
const events = toEvents(bot)

const alice = { id: 7, is_bot: false, username: "alice" }
const group = { id: -100123, type: "supergroup" }

/** A `message` update through the real decoder, as the poller hands it over. */
const message = (fields: Record<string, unknown>) =>
  events(
    Schema.decodeUnknownSync(Update)({
      update_id: 1,
      message: { message_id: 10, from: alice, chat: group, ...fields },
    }),
  )[0]

const entity = (type: string, text: string, needle: string) => ({
  type,
  offset: text.indexOf(needle),
  length: needle.length,
})

describe("addressed", () => {
  it("is a DM, a mention, or a reply to the bot, and nothing else", () => {
    const mentioned = "@helperbot ping"
    expect(message({ chat: { id: 7, type: "private" }, text: "hi" })).toMatchObject({
      addressed: true,
    })
    expect(
      message({ text: mentioned, entities: [entity("mention", mentioned, "@helperbot")] }),
    ).toMatchObject({ addressed: true })
    expect(
      message({
        text: "and?",
        reply_to_message: { message_id: 9, from: { id: 42, is_bot: true } },
      }),
    ).toMatchObject({ addressed: true, replyTo: "9" })
    expect(
      message({ text: "and?", reply_to_message: { message_id: 9, from: alice } }),
    ).toMatchObject({ addressed: false })
    expect(message({ text: "lunch anyone" })).toMatchObject({ addressed: false })
  })

  it("strips only the bot's own mention, wherever it sits", () => {
    const text = "@alice ask @HelperBot: what time is it?"
    expect(
      message({
        text,
        entities: [entity("mention", text, "@alice"), entity("mention", text, "@HelperBot")],
      }),
    ).toMatchObject({ text: "@alice ask : what time is it?" })
  })
})

describe("commands", () => {
  it("parses `/name@bot args` at offset 0 and strips the bot suffix", () => {
    const text = "/search@HelperBot effect  streams"
    expect(
      message({ text, entities: [entity("bot_command", text, "/search@HelperBot")] }),
    ).toMatchObject({ _tag: "Command", name: "search", args: "effect  streams" })
  })

  it("leaves a mid-text /word and another bot's command as plain messages", () => {
    const mid = "try /help later"
    const other = "/start@OtherBot"
    expect(message({ text: mid, entities: [entity("bot_command", mid, "/help")] })).toMatchObject({
      _tag: "Message",
      text: mid,
    })
    expect(message({ text: other, entities: [entity("bot_command", other, other)] })).toMatchObject(
      { _tag: "Message", addressed: false },
    )
  })
})

describe("threads", () => {
  it("is the forum topic, never a reply chain's thread id", () => {
    expect(message({ text: "a", message_thread_id: 5, is_topic_message: true })).toMatchObject({
      conversation: { channel: "-100123", thread: "5" },
    })
    expect(message({ text: "b", message_thread_id: 5 })).toMatchObject({
      conversation: { channel: "-100123" },
    })
    expect(message({ text: "b", message_thread_id: 5 })).not.toHaveProperty("conversation.thread")
  })
})

describe("other updates", () => {
  it("emits one Reaction per emoji and skips custom ones", () => {
    const update = Schema.decodeUnknownSync(Update)({
      update_id: 2,
      message_reaction: {
        chat: group,
        message_id: 10,
        user: alice,
        new_reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji" }],
      },
    })
    expect(events(update)).toMatchObject([{ _tag: "Reaction", emoji: "👍", message: "10" }])
  })

  it("swallows edited messages so they are acked but never re-answered", () => {
    const update = Schema.decodeUnknownSync(Update)({
      update_id: 4,
      edited_message: { message_id: 10, from: alice, chat: group, text: "edited" },
    })
    expect(events(update)).toEqual([])
  })
})
