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
  id: Schema.Number,
  is_bot: Schema.Boolean,
  username: Schema.optional(Schema.String),
})
export type User = typeof User.Type

export const Chat = Schema.Struct({
  id: Schema.Number,
  type: Schema.String,
})
export type Chat = typeof Chat.Type

export const Entity = Schema.Struct({
  type: Schema.String,
  offset: Schema.Number,
  length: Schema.Number,
})
export type Entity = typeof Entity.Type

/** Where a message sits: its chat, and its forum topic when it is in one. */
export const Placement = Schema.Struct({
  chat: Chat,
  message_thread_id: Schema.optional(Schema.Number),
  is_topic_message: Schema.optional(Schema.Boolean),
})
export type Placement = typeof Placement.Type

export const ReplyTarget = Schema.Struct({
  message_id: Schema.Number,
  from: Schema.optional(User),
})
export type ReplyTarget = typeof ReplyTarget.Type

export const Message = Schema.Struct({
  ...Placement.fields,
  message_id: Schema.Number,
  from: Schema.optional(User),
  text: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  entities: Schema.optional(Schema.Array(Entity)),
  reply_to_message: Schema.optional(ReplyTarget),
})
export type Message = typeof Message.Type

export const Reaction = Schema.Struct({
  type: Schema.String,
  emoji: Schema.optional(Schema.String),
})
export type Reaction = typeof Reaction.Type

export const MessageReaction = Schema.Struct({
  chat: Chat,
  message_id: Schema.Number,
  user: Schema.optional(User),
  new_reaction: Schema.Array(Reaction),
})
export type MessageReaction = typeof MessageReaction.Type

export const CallbackQuery = Schema.Struct({
  id: Schema.String,
  from: User,
  data: Schema.optional(Schema.String),
  message: Schema.optional(Schema.Struct({ ...Placement.fields, message_id: Schema.Number })),
})
export type CallbackQuery = typeof CallbackQuery.Type

export const Update = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optional(Message),
  edited_message: Schema.optional(Message),
  message_reaction: Schema.optional(MessageReaction),
  callback_query: Schema.optional(CallbackQuery),
})
export type Update = typeof Update.Type

/** Requested on every `getUpdates`; without it Telegram never delivers reactions. */
export const allowedUpdates = [
  "message",
  "edited_message",
  "callback_query",
  "message_reaction",
] as const

export type BotIdentity = {
  readonly id: number
  readonly username: string
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const conversation = (at: Placement): ConversationRef => ({
  channel: ChannelId(String(at.chat.id)),
  // Forum topics are threads; reply chains are not (they carry no thread id).
  ...(at.is_topic_message === true &&
    at.message_thread_id !== undefined && { thread: String(at.message_thread_id) }),
})

const slice = (text: string, entity: Entity): string =>
  text.slice(entity.offset, entity.offset + entity.length)

const isOwnHandle = (bot: BotIdentity, handle: string): boolean =>
  handle.toLowerCase() === `@${bot.username}`.toLowerCase()

const entitiesOf = (message: Message): ReadonlyArray<Entity> => message.entities ?? []

const ownMentions = (bot: BotIdentity, message: Message, text: string): ReadonlyArray<Entity> =>
  entitiesOf(message).filter(
    (entity) => entity.type === "mention" && isOwnHandle(bot, slice(text, entity)),
  )

type Command = { readonly name: string; readonly args: string }

/** `/name@bot args` at offset 0 is a command; a mid-text `/word` is just text. */
const command = (bot: BotIdentity, message: Message, text: string): Option.Option<Command> =>
  Arr.findFirst(
    entitiesOf(message),
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  ).pipe(
    Option.flatMap((entity) => {
      const [name = "", suffix] = slice(text, entity).slice(1).split("@")
      // A command aimed at another bot arrives under privacy-off, but is not ours.
      return suffix !== undefined && !isOwnHandle(bot, `@${suffix}`)
        ? Option.none()
        : Option.some({ name, args: text.slice(entity.length).trim() })
    }),
  )

/** The bot's own `@handle` removed, right to left so earlier offsets stay valid. */
const withoutMention = (bot: BotIdentity, message: Message, text: string): string =>
  Arr.reverse(ownMentions(bot, message, text))
    .reduce(
      (acc, entity) => acc.slice(0, entity.offset) + acc.slice(entity.offset + entity.length),
      text,
    )
    .trim()

const isAddressed = (bot: BotIdentity, message: Message, text: string): boolean =>
  message.chat.type === "private" ||
  ownMentions(bot, message, text).length > 0 ||
  message.reply_to_message?.from?.id === bot.id

const fromMessage = (
  bot: BotIdentity,
  message: Message,
  raw: unknown,
): Option.Option<InboundEvent> =>
  Option.map(Option.fromNullishOr(message.from), (from) => {
    const text = message.text ?? message.caption ?? ""
    const author = UserId(String(from.id))
    const at = conversation(message)
    return Option.match(command(bot, message, text), {
      onSome: ({ name, args }) =>
        InboundEvent.Command({ conversation: at, name, args, author, raw }),
      onNone: () =>
        InboundEvent.Message({
          conversation: at,
          id: MessageId(String(message.message_id)),
          author,
          text: withoutMention(bot, message, text),
          addressed: isAddressed(bot, message, text),
          ...(message.reply_to_message !== undefined && {
            replyTo: MessageId(String(message.reply_to_message.message_id)),
          }),
          raw,
        }),
    })
  })

const fromReaction = (reaction: MessageReaction, raw: unknown): ReadonlyArray<InboundEvent> =>
  Option.match(Option.fromNullishOr(reaction.user), {
    onNone: () => [],
    onSome: (user) =>
      Arr.flatMap(reaction.new_reaction, (r) =>
        Arr.fromNullishOr(r.emoji).map((emoji) =>
          InboundEvent.Reaction({
            conversation: conversation({ chat: reaction.chat }),
            message: MessageId(String(reaction.message_id)),
            emoji,
            author: UserId(String(user.id)),
            raw,
          }),
        ),
      ),
  })

const fromCallback = (query: CallbackQuery, raw: unknown): Option.Option<InboundEvent> =>
  Option.map(Option.fromNullishOr(query.message), (message) =>
    InboundEvent.Action({
      conversation: conversation(message),
      actionId: query.data ?? "",
      author: UserId(String(query.from.id)),
      raw,
    }),
  )

/**
 * Everything one `Update` says to the agent. Edited messages are received
 * (so the offset advances past them) but not re-delivered: a turn already
 * answered them.
 */
export const toEvents =
  (bot: BotIdentity) =>
  (update: Update): ReadonlyArray<InboundEvent> =>
    Match.value(update).pipe(
      Match.when({ message: Match.defined }, ({ message }) =>
        Arr.fromOption(fromMessage(bot, message, update)),
      ),
      Match.when({ message_reaction: Match.defined }, ({ message_reaction }) =>
        fromReaction(message_reaction, update),
      ),
      Match.when({ callback_query: Match.defined }, ({ callback_query }) =>
        Arr.fromOption(fromCallback(callback_query, update)),
      ),
      Match.orElse(() => []),
    )
