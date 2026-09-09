import { Array as Arr, Match, Option, Schema } from "effect"
import {
  ChannelId,
  type ConversationRef,
  InboundEvent,
  MessageId,
  ThreadId,
  UserId,
} from "@effect-uai/core/Messenger"

// ---------------------------------------------------------------------------
// Wire shapes: the fields this adapter reads. The rest survives on `raw`.
// ---------------------------------------------------------------------------

export const AppMention = Schema.Struct({
  type: Schema.Literal("app_mention"),
  channel: Schema.String,
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  ts: Schema.String,
  thread_ts: Schema.optional(Schema.String),
})
export type AppMention = typeof AppMention.Type

export const Message = Schema.Struct({
  type: Schema.Literal("message"),
  channel: Schema.String,
  /** `channel`, `group`, `im` or `mpim`. Authoritative for what kind of chat this is. */
  channel_type: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  ts: Schema.String,
  thread_ts: Schema.optional(Schema.String),
})
export type Message = typeof Message.Type

export const ReactionAdded = Schema.Struct({
  type: Schema.Literal("reaction_added"),
  user: Schema.String,
  /** A shortcode without colons, which is also what `reactions.add` takes. */
  reaction: Schema.String,
  item: Schema.Struct({ channel: Schema.String, ts: Schema.String }),
})
export type ReactionAdded = typeof ReactionAdded.Type

/** The events this adapter subscribes to. Anything else fails to decode and is dropped. */
export const Event = Schema.Union([AppMention, Message, ReactionAdded])
export type Event = typeof Event.Type

export const EventsApi = Schema.Struct({
  type: Schema.Literal("events_api"),
  envelope_id: Schema.String,
  payload: Schema.Struct({
    /** Stable across a redelivery, which is what the socket dedupes on. */
    event_id: Schema.optional(Schema.String),
    event: Event,
  }),
})
export type EventsApi = typeof EventsApi.Type

export const BlockAction = Schema.Struct({
  action_id: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
})
export type BlockAction = typeof BlockAction.Type

export const Interactive = Schema.Struct({
  type: Schema.Literal("interactive"),
  envelope_id: Schema.String,
  payload: Schema.Struct({
    /** `block_actions`, `view_submission`, `shortcut`; only the first maps. */
    type: Schema.String,
    user: Schema.Struct({ id: Schema.String }),
    container: Schema.optional(
      Schema.Struct({
        channel_id: Schema.optional(Schema.String),
        thread_ts: Schema.optional(Schema.String),
      }),
    ),
    channel: Schema.optional(Schema.Struct({ id: Schema.String })),
    actions: Schema.optional(Schema.Array(BlockAction)),
  }),
})
export type Interactive = typeof Interactive.Type

export const SlashCommand = Schema.Struct({
  type: Schema.Literal("slash_commands"),
  envelope_id: Schema.String,
  payload: Schema.Struct({
    channel_id: Schema.String,
    user_id: Schema.String,
    command: Schema.String,
    text: Schema.optional(Schema.String),
  }),
})
export type SlashCommand = typeof SlashCommand.Type

/** A frame carrying work, and so an `envelope_id` that has to be acknowledged. */
export const Envelope = Schema.Union([EventsApi, Interactive, SlashCommand])
export type Envelope = typeof Envelope.Type

export const Hello = Schema.Struct({ type: Schema.Literal("hello") })

export const Disconnect = Schema.Struct({
  type: Schema.Literal("disconnect"),
  reason: Schema.optional(Schema.String),
})

/** Everything Socket Mode sends down the wire. */
export const Frame = Schema.Union([Hello, Disconnect, EventsApi, Interactive, SlashCommand])
export type Frame = typeof Frame.Type

/** From `auth.test` at layer build: the identity behind `addressed`. */
export type BotIdentity = {
  readonly userId: string
  readonly botId: string
  readonly teamId: string
}

/** Where a top-level mention is answered: in a thread under it, or in the channel. */
export type ReplyIn = "thread" | "channel"

export type Options = {
  readonly bot: BotIdentity
  readonly replyIn: ReplyIn
}

/** The id Slack repeats when it redelivers. Only an `events_api` frame carries one. */
export const eventId = (envelope: Envelope): Option.Option<string> =>
  envelope.type === "events_api" ? Option.fromNullishOr(envelope.payload.event_id) : Option.none()

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

// Slack ids name their own kind, and `channel_type` says so outright where the
// payload has one. Group DMs are `mpim` and are treated as a channel.
const isDirect = (channel: string, channelType?: string): boolean =>
  channelType === "im" || (channelType === undefined && channel.startsWith("D"))

/**
 * Under `replyIn: "thread"` a channel message with no thread of its own gets
 * one minted from its own `ts`, so the bot answers under the mention and a
 * follow-up inside that thread is the same conversation. A DM never does.
 */
const conversation = (
  options: Options,
  channel: string,
  ts: string,
  threadTs: string | undefined,
  direct: boolean,
): ConversationRef => {
  const thread = threadTs ?? (options.replyIn === "thread" && !direct ? ts : undefined)
  return {
    channel: ChannelId(channel),
    ...(thread !== undefined && { thread: ThreadId(thread) }),
  }
}

// Slack writes a mention as `<@U123>`, or `<@U123|name>` in older payloads.
const mention = (userId: string): RegExp => new RegExp(`<@${userId}(\\|[^>]*)?>`, "g")

const mentionsBot = (bot: BotIdentity, text: string): boolean => mention(bot.userId).test(text)

/** The bot's own mention removed; other users' mentions stay as Slack wrote them. */
const withoutMention = (bot: BotIdentity, text: string): string =>
  text.replace(mention(bot.userId), "").trim()

// Anything the bot itself or another app posted, so two bots cannot answer
// each other.
const fromBot = (
  bot: BotIdentity,
  event: { readonly bot_id?: string | undefined; readonly user?: string | undefined },
): boolean => event.bot_id !== undefined || event.user === bot.userId

// Subtypes that are not a person saying something new.
const droppedSubtypes = [
  "bot_message",
  "message_changed",
  "message_deleted",
  "thread_broadcast",
  "file_share",
]

const fromMessage = (
  options: Options,
  event: Message,
  raw: unknown,
): Option.Option<InboundEvent> => {
  const direct = isDirect(event.channel, event.channel_type)
  const text = event.text ?? ""
  const keep =
    !droppedSubtypes.includes(event.subtype ?? "") &&
    !fromBot(options.bot, event) &&
    // In a channel the very same message also arrives as `app_mention`, and
    // that is the copy this adapter keeps.
    (direct || !mentionsBot(options.bot, text))
  return keep
    ? Option.map(Option.fromNullishOr(event.user), (user) =>
        InboundEvent.Message({
          conversation: conversation(options, event.channel, event.ts, event.thread_ts, direct),
          id: MessageId(event.ts),
          author: UserId(user),
          text: withoutMention(options.bot, text),
          // A thread follow-up without a mention is not addressed: the payload
          // does not say who opened the thread and this adapter keeps no memory.
          addressed: direct,
          raw,
        }),
      )
    : Option.none()
}

const fromMention = (
  options: Options,
  event: AppMention,
  raw: unknown,
): Option.Option<InboundEvent> =>
  // A mention inside a DM already arrived as `message.im`.
  Option.liftPredicate(event, (e) => !isDirect(e.channel) && !fromBot(options.bot, e)).pipe(
    Option.flatMap((e) =>
      Option.map(Option.fromNullishOr(e.user), (user) =>
        InboundEvent.Message({
          conversation: conversation(options, e.channel, e.ts, e.thread_ts, false),
          id: MessageId(e.ts),
          author: UserId(user),
          text: withoutMention(options.bot, e.text ?? ""),
          addressed: true,
          raw,
        }),
      ),
    ),
  )

const fromReaction = (
  options: Options,
  event: ReactionAdded,
  raw: unknown,
): Option.Option<InboundEvent> =>
  Option.liftPredicate(event, (e) => e.user !== options.bot.userId).pipe(
    Option.map((e) =>
      InboundEvent.Reaction({
        // `reaction_added` names the message but not the thread it sits in, so
        // under `replyIn: "thread"` this matches a reaction on the message that
        // opened the thread and nothing deeper.
        conversation: conversation(
          options,
          e.item.channel,
          e.item.ts,
          undefined,
          isDirect(e.item.channel),
        ),
        message: MessageId(e.item.ts),
        emoji: e.reaction,
        author: UserId(e.user),
        raw,
      }),
    ),
  )

const fromEvent = (options: Options, event: Event, raw: unknown): Option.Option<InboundEvent> =>
  Match.value(event).pipe(
    Match.when({ type: "app_mention" }, (e) => fromMention(options, e, raw)),
    Match.when({ type: "message" }, (e) => fromMessage(options, e, raw)),
    Match.when({ type: "reaction_added" }, (e) => fromReaction(options, e, raw)),
    Match.exhaustive,
  )

const BLOCK_ACTIONS = "block_actions"

const actionConversation = (payload: Interactive["payload"]): Option.Option<ConversationRef> =>
  Option.map(
    Option.fromNullishOr(payload.container?.channel_id ?? payload.channel?.id),
    (channel) => ({
      channel: ChannelId(channel),
      ...(payload.container?.thread_ts !== undefined && {
        thread: ThreadId(payload.container.thread_ts),
      }),
    }),
  )

/** One `Action` per pressed element; a view submission or shortcut is ignored. */
const fromInteractive = (
  payload: Interactive["payload"],
  raw: unknown,
): ReadonlyArray<InboundEvent> =>
  payload.type !== BLOCK_ACTIONS
    ? []
    : Option.match(actionConversation(payload), {
        onNone: () => [],
        onSome: (at) =>
          (payload.actions ?? []).map((action) =>
            InboundEvent.Action({
              conversation: at,
              actionId: action.action_id ?? "",
              ...(action.value !== undefined && { value: action.value }),
              author: UserId(payload.user.id),
              raw,
            }),
          ),
      })

const fromCommand = (payload: SlashCommand["payload"], raw: unknown): InboundEvent =>
  InboundEvent.Command({
    // A slash command names no thread, so it starts at channel level.
    conversation: { channel: ChannelId(payload.channel_id) },
    name: payload.command.startsWith("/") ? payload.command.slice(1) : payload.command,
    args: (payload.text ?? "").trim(),
    author: UserId(payload.user_id),
    raw,
  })

/**
 * Everything one envelope says to the agent. `raw` is the frame as it came off
 * the wire, since decoding keeps only the fields above.
 */
export const toEvents =
  (options: Options) =>
  (envelope: Envelope, raw: unknown): ReadonlyArray<InboundEvent> =>
    Match.value(envelope).pipe(
      Match.when({ type: "events_api" }, ({ payload }) =>
        Arr.fromOption(fromEvent(options, payload.event, raw)),
      ),
      Match.when({ type: "interactive" }, ({ payload }) => fromInteractive(payload, raw)),
      Match.when({ type: "slash_commands" }, ({ payload }) => [fromCommand(payload, raw)]),
      Match.exhaustive,
    )
