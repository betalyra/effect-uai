import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { type BotIdentity, Dispatch, toEvents } from "./events.js"

const bot: BotIdentity = { id: "42", username: "HelperBot" }
const events = toEvents(bot)

const alice = { id: "7", username: "alice" }

/** One dispatch through the real decoder, as the gateway hands it over. */
const dispatch = (t: string, d: Record<string, unknown>) =>
  events(Schema.decodeUnknownSync(Dispatch)({ t, d }), d)[0]

const message = (fields: Record<string, unknown>) =>
  dispatch("MESSAGE_CREATE", {
    id: "10",
    channel_id: "555",
    guild_id: "100",
    author: alice,
    ...fields,
  })

describe("addressed", () => {
  it("is a DM, a mention, or a reply to the bot, and nothing else", () => {
    expect(message({ guild_id: undefined, content: "hi" })).toMatchObject({ addressed: true })
    expect(message({ content: "<@42> ping", mentions: [{ id: "42" }] })).toMatchObject({
      addressed: true,
    })
    expect(
      message({ content: "and?", referenced_message: { id: "9", author: { id: "42" } } }),
    ).toMatchObject({ addressed: true, replyTo: "9" })
    expect(
      message({ content: "and?", referenced_message: { id: "9", author: alice } }),
    ).toMatchObject({ addressed: false, replyTo: "9" })
    // `@everyone` and role pings never land in `mentions`.
    expect(message({ content: "@everyone lunch?", mention_everyone: true })).toMatchObject({
      addressed: false,
    })
  })

  it("strips both spellings of the bot's own mention and leaves other users'", () => {
    expect(
      message({ content: "<@!42> ask <@7> too", mentions: [{ id: "42" }, alice] }),
    ).toMatchObject({ text: "ask <@7> too" })
  })

  it("drops messages another bot wrote, so two bots cannot answer each other", () => {
    expect(message({ content: "hello", author: { id: "99", bot: true } })).toBeUndefined()
  })
})

describe("reactions", () => {
  const add = (emoji: Record<string, unknown>, user_id = "7") =>
    dispatch("MESSAGE_REACTION_ADD", { user_id, channel_id: "555", message_id: "10", emoji })

  it("names unicode by itself and custom emoji as `name:id`", () => {
    expect(add({ id: null, name: "👀" })).toMatchObject({ _tag: "Reaction", emoji: "👀" })
    expect(add({ id: "8", name: "blobcat" })).toMatchObject({ emoji: "blobcat:8" })
  })

  it("drops the bot's own reactions", () => {
    expect(add({ id: null, name: "👀" }, "42")).toBeUndefined()
  })
})

describe("interactions", () => {
  const interaction = (type: number, data: Record<string, unknown>) =>
    dispatch("INTERACTION_CREATE", {
      id: "1",
      token: "tok",
      type,
      channel_id: "555",
      member: { user: alice },
      data,
    })

  it("maps a component press to an Action, joining a select's values", () => {
    expect(interaction(3, { custom_id: "approve:12", values: ["a", "b"] })).toMatchObject({
      _tag: "Action",
      actionId: "approve:12",
      value: "a,b",
      author: "7",
    })
  })

  it("ignores interaction types that need a response of their own", () => {
    expect(interaction(2, { name: "search" })).toBeUndefined()
  })
})
