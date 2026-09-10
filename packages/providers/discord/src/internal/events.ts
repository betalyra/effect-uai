import { Array as Arr, Match, Option, Schema } from "effect"
import {
  ChannelId,
  type ConversationRef,
  InboundEvent,
  MessageId,
  UserId,
} from "@effect-uai/core/Messenger"

// ---------------------------------------------------------------------------
// Wire shapes: the fields this adapter reads. The rest survives on `raw`.
// ---------------------------------------------------------------------------

export const User = Schema.Struct({
  id: Schema.String,
  username: Schema.optional(Schema.String),
  bot: Schema.optional(Schema.Boolean),
})
export type User = typeof User.Type

/** Unicode reactions carry a `name` and a null `id`; custom ones carry both. */
export const Emoji = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
})
export type Emoji = typeof Emoji.Type

export const ReplyTarget = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(User),
})
export type ReplyTarget = typeof ReplyTarget.Type

export const MessageCreate = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  // Absent in a DM, which is how a DM is recognised.
  guild_id: Schema.optional(Schema.String),
  author: User,
  content: Schema.optional(Schema.String),
  mentions: Schema.optional(Schema.Array(User)),
  referenced_message: Schema.optional(Schema.NullOr(ReplyTarget)),
})
export type MessageCreate = typeof MessageCreate.Type

export const ReactionAdd = Schema.Struct({
  user_id: Schema.String,
  channel_id: Schema.String,
  message_id: Schema.String,
  emoji: Emoji,
})
export type ReactionAdd = typeof ReactionAdd.Type

export const InteractionData = Schema.Struct({
  custom_id: Schema.optional(Schema.String),
  values: Schema.optional(Schema.Array(Schema.String)),
})
export type InteractionData = typeof InteractionData.Type

export const InteractionCreate = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
  /** 1 ping, 2 slash command, 3 message component, 4 autocomplete, 5 modal. */
  type: Schema.Number,
  channel_id: Schema.optional(Schema.String),
  user: Schema.optional(User),
  member: Schema.optional(Schema.Struct({ user: Schema.optional(User) })),
  data: Schema.optional(InteractionData),
})
export type InteractionCreate = typeof InteractionCreate.Type

/** The component interaction type; every other one is ignored in v1. */
export const MESSAGE_COMPONENT = 3

/**
 * The dispatches this adapter reads, discriminated by the gateway's `t`.
 * Anything else fails to decode and is dropped by the session.
 */
export const Dispatch = Schema.Union([
  Schema.Struct({ t: Schema.Literal("MESSAGE_CREATE"), d: MessageCreate }),
  Schema.Struct({ t: Schema.Literal("MESSAGE_REACTION_ADD"), d: ReactionAdd }),
  Schema.Struct({ t: Schema.Literal("INTERACTION_CREATE"), d: InteractionCreate }),
])
export type Dispatch = typeof Dispatch.Type

export type BotIdentity = {
  readonly id: string
  readonly username: string
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

// A Discord thread is a channel of its own, so `thread` is never set here and
// `conversationKey` still separates a thread from its parent.
const conversation = (channelId: string): ConversationRef => ({ channel: ChannelId(channelId) })

const mentionsBot = (bot: BotIdentity, message: MessageCreate): boolean =>
  (message.mentions ?? []).some((user) => user.id === bot.id)

// `@everyone` and role mentions are not in `mentions`, so they never address.
const isAddressed = (bot: BotIdentity, message: MessageCreate): boolean =>
  message.guild_id === undefined ||
  mentionsBot(bot, message) ||
  message.referenced_message?.author?.id === bot.id

/** Both mention spellings of the bot removed; other users' mentions stay. */
const withoutMention = (bot: BotIdentity, text: string): string =>
  text.replaceAll(`<@${bot.id}>`, "").replaceAll(`<@!${bot.id}>`, "").trim()

const fromMessage = (
  bot: BotIdentity,
  message: MessageCreate,
  raw: unknown,
): Option.Option<InboundEvent> =>
  // Bot authors are dropped outright, so two bots cannot answer each other.
  Option.liftPredicate(message, (m) => m.author.bot !== true).pipe(
    Option.map((m) =>
      InboundEvent.Message({
        conversation: conversation(m.channel_id),
        id: MessageId(m.id),
        author: UserId(m.author.id),
        text: withoutMention(bot, m.content ?? ""),
        addressed: isAddressed(bot, m),
        ...(m.referenced_message != null && { replyTo: MessageId(m.referenced_message.id) }),
        raw,
      }),
    ),
  )

/** Unicode reactions are their own name; custom ones are `name:id`, as REST wants. */
const emojiName = (emoji: Emoji): Option.Option<string> =>
  Option.map(Option.fromNullishOr(emoji.name), (name) =>
    emoji.id == null ? name : `${name}:${emoji.id}`,
  )

const fromReaction = (
  bot: BotIdentity,
  reaction: ReactionAdd,
  raw: unknown,
): Option.Option<InboundEvent> =>
  Option.liftPredicate(reaction, (r) => r.user_id !== bot.id).pipe(
    Option.flatMap((r) =>
      Option.map(emojiName(r.emoji), (emoji) =>
        InboundEvent.Reaction({
          conversation: conversation(r.channel_id),
          message: MessageId(r.message_id),
          emoji,
          author: UserId(r.user_id),
          raw,
        }),
      ),
    ),
  )

const interactionAuthor = (interaction: InteractionCreate): Option.Option<string> =>
  Option.fromNullishOr(interaction.user?.id ?? interaction.member?.user?.id)

/** A select delivers several values; the shared shape carries them comma-joined. */
const fromInteraction = (
  interaction: InteractionCreate,
  raw: unknown,
): Option.Option<InboundEvent> =>
  Option.liftPredicate(interaction, (i) => i.type === MESSAGE_COMPONENT).pipe(
    Option.flatMap((i) =>
      Option.all([Option.fromNullishOr(i.channel_id), interactionAuthor(i)]).pipe(
        Option.map(([channelId, author]) =>
          InboundEvent.Action({
            conversation: conversation(channelId),
            actionId: i.data?.custom_id ?? "",
            ...(i.data?.values !== undefined && { value: i.data.values.join(",") }),
            author: UserId(author),
            raw,
          }),
        ),
      ),
    ),
  )

/**
 * Everything one dispatch says to the agent. `raw` is the payload as it came
 * off the wire, since decoding keeps only the fields above. Discord has no
 * text-command convention, so nothing here becomes a `Command`: slash
 * commands are a follow-up and need an interaction response of their own.
 */
export const toEvents =
  (bot: BotIdentity) =>
  (dispatch: Dispatch, raw: unknown): ReadonlyArray<InboundEvent> =>
    Arr.fromOption(
      Match.value(dispatch).pipe(
        Match.when({ t: "MESSAGE_CREATE" }, ({ d }) => fromMessage(bot, d, raw)),
        Match.when({ t: "MESSAGE_REACTION_ADD" }, ({ d }) => fromReaction(bot, d, raw)),
        Match.when({ t: "INTERACTION_CREATE" }, ({ d }) => fromInteraction(d, raw)),
        Match.exhaustive,
      ),
    )
