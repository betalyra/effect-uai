import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { type BotIdentity, Envelope, type Options, type ReplyIn, toEvents } from "./events.js"

const bot: BotIdentity = { userId: "UBOT", botId: "BBOT", teamId: "T1" }

const options = (replyIn: ReplyIn = "thread"): Options => ({ bot, replyIn })

/** One frame through the real decoder, as the socket hands it over. */
const frame = (raw: Record<string, unknown>, replyIn?: ReplyIn) =>
  toEvents(options(replyIn))(Schema.decodeUnknownSync(Envelope)(raw), raw)

const event = (payload: Record<string, unknown>, replyIn?: ReplyIn) =>
  frame(
    { type: "events_api", envelope_id: "e1", payload: { event_id: "Ev1", event: payload } },
    replyIn,
  )[0]

const message = (fields: Record<string, unknown>, replyIn?: ReplyIn) =>
  event(
    { type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "1.1", ...fields },
    replyIn,
  )

const mention = (fields: Record<string, unknown>, replyIn?: ReplyIn) =>
  event({ type: "app_mention", channel: "C1", user: "U1", ts: "1.1", ...fields }, replyIn)

describe("addressed", () => {
  it("is a DM or a mention, and a thread follow-up without one is neither", () => {
    expect(message({ channel: "D1", channel_type: "im", text: "hi" })).toMatchObject({
      addressed: true,
    })
    expect(mention({ text: "<@UBOT> ping" })).toMatchObject({ addressed: true })
    expect(message({ text: "still there?", thread_ts: "1.0" })).toMatchObject({ addressed: false })
  })

  it("strips the bot's own mention, labelled or not, and leaves other users'", () => {
    expect(mention({ text: "<@UBOT|betty> ask <@U9> too" })).toMatchObject({
      text: "ask <@U9> too",
    })
  })
})

describe("one event per message", () => {
  // Slack sends a channel mention twice, as `app_mention` and `message`, and
  // sends a mention inside a DM only as `message.im`.
  it("keeps the app_mention in a channel and the message in a DM", () => {
    expect(message({ text: "<@UBOT> ping" })).toBeUndefined()
    expect(mention({ text: "<@UBOT> ping" })).toMatchObject({ _tag: "Message", id: "1.1" })
    expect(message({ channel: "D1", channel_type: "im", text: "<@UBOT> hi" })).toMatchObject({
      text: "hi",
    })
    expect(mention({ channel: "D1" })).toBeUndefined()
  })

  it("ignores edits and every bot, so two bots cannot answer each other", () => {
    expect(message({ subtype: "message_changed", text: "edited" })).toBeUndefined()
    expect(message({ bot_id: "B2", text: "hi" })).toBeUndefined()
    expect(message({ user: "UBOT", text: "my own words" })).toBeUndefined()
  })
})

describe("conversation", () => {
  it("mints a thread from a top-level mention only under replyIn thread", () => {
    expect(mention({ ts: "1.1" }, "thread")).toMatchObject({
      conversation: { channel: "C1", thread: "1.1" },
    })
    expect(mention({ ts: "1.1" }, "channel")).toMatchObject({ conversation: { channel: "C1" } })
  })

  it("keeps a follow-up in the thread it was written in, and a DM out of one", () => {
    expect(mention({ ts: "2.2", thread_ts: "1.1" })).toMatchObject({
      conversation: { channel: "C1", thread: "1.1" },
    })
    expect(message({ channel: "D1", channel_type: "im", text: "hi" })).toMatchObject({
      conversation: { channel: "D1" },
    })
  })
})

describe("reactions", () => {
  const added = (user = "U1") =>
    event({ type: "reaction_added", user, reaction: "eyes", item: { channel: "C1", ts: "1.1" } })

  it("names the reacted message as its own thread, and drops the bot's own", () => {
    // `reaction_added` carries no `thread_ts`, so this matches a reaction on the
    // message that opened the thread and nothing deeper.
    expect(added()).toMatchObject({ emoji: "eyes", conversation: { thread: "1.1" } })
    expect(added("UBOT")).toBeUndefined()
  })
})

describe("commands and actions", () => {
  it("drops the slash and keeps the rest as args", () => {
    expect(
      frame({
        type: "slash_commands",
        envelope_id: "e1",
        payload: { channel_id: "C1", user_id: "U1", command: "/start", text: "  now  " },
      })[0],
    ).toMatchObject({ _tag: "Command", name: "start", args: "now" })
  })

  const interactive = (payload: Record<string, unknown>) =>
    frame({ type: "interactive", envelope_id: "e1", payload })

  it("maps every pressed element, and ignores payloads needing their own reply", () => {
    expect(
      interactive({
        type: "block_actions",
        user: { id: "U1" },
        container: { channel_id: "C1", thread_ts: "1.1" },
        actions: [{ action_id: "approve", value: "12" }, { action_id: "deny" }],
      }),
    ).toMatchObject([
      { actionId: "approve", value: "12", conversation: { thread: "1.1" } },
      { actionId: "deny" },
    ])
    expect(interactive({ type: "view_submission", user: { id: "U1" } })).toEqual([])
  })
})
