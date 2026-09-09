import { Brand, Context, Data, Effect, type Option, type Scope, Stream } from "effect"
import type { MediaSource } from "../domain/Media.js"
import type * as MessengerError from "./MessengerError.js"

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Where messages go. Providers mint these per their own scheme; core treats them opaquely. */
export type ChannelId = Brand.Branded<string, "ChannelId">
export const ChannelId = Brand.nominal<ChannelId>()

/** One message inside a channel. Only a named message can be edited or reacted to. */
export type MessageId = Brand.Branded<string, "MessageId">
export const MessageId = Brand.nominal<MessageId>()

/** The human (or bot) an event came from. */
export type UserId = Brand.Branded<string, "UserId">
export const UserId = Brand.nominal<UserId>()

/** A sub-conversation inside a channel, where the platform has one. Opaque, provider-minted. */
export type ThreadId = Brand.Branded<string, "ThreadId">
export const ThreadId = Brand.nominal<ThreadId>()

/**
 * Where a conversation happens. `thread` is provider-interpreted: a Slack
 * `thread_ts`, a Telegram forum topic, unset on Discord (where a thread is
 * its own channel).
 */
export type ConversationRef = {
  readonly channel: ChannelId
  readonly thread?: ThreadId
}

export type MessageRef = {
  readonly conversation: ConversationRef
  readonly id: MessageId
}

/** Stable key for a conversation. Index per-conversation state with it. */
export const conversationKey = (ref: ConversationRef): string =>
  ref.thread === undefined ? ref.channel : `${ref.channel}/${ref.thread}`

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * What the world says to the agent. `raw` is the untouched platform payload,
 * for everything the shared shape drops.
 *
 * `addressed` is the rule recipes branch on: a DM, a mention of the bot, or
 * a reply to one of its messages. Each adapter owns that decision (and hides
 * Telegram privacy mode / Discord intents behind it), and delivers `text`
 * with the bot's own mention stripped.
 *
 * `Reaction.emoji` is the platform's own spelling, the same one `react`
 * accepts: unicode where the platform speaks unicode, a shortcode where it
 * speaks shortcodes.
 */
export type InboundEvent = Data.TaggedEnum<{
  Message: {
    readonly conversation: ConversationRef
    readonly id: MessageId
    readonly author: UserId
    readonly text: string
    readonly addressed: boolean
    readonly replyTo?: MessageId
    readonly raw: unknown
  }
  Reaction: {
    readonly conversation: ConversationRef
    readonly message: MessageId
    readonly emoji: string
    readonly author: UserId
    readonly raw: unknown
  }
  Command: {
    readonly conversation: ConversationRef
    readonly name: string
    readonly args: string
    readonly author: UserId
    readonly raw: unknown
  }
  Action: {
    readonly conversation: ConversationRef
    readonly actionId: string
    readonly value?: string
    readonly author: UserId
    readonly raw: unknown
  }
}>

export const InboundEvent = Data.taggedEnum<InboundEvent>()

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * What the agent says. `Text` is sent verbatim: each provider layer says
 * which markup it expects (Telegram HTML, Slack markdown), and the prompt is
 * where that gets decided. Nothing here converts. `Media` reuses the core
 * {@link MediaSource}, so a URL, base64 or raw bytes all work; the adapter
 * routes on `mimeType` (`image/*` to a photo endpoint, `audio/*` to an audio
 * one, everything else to a file upload), which is why a URL source without
 * a `mimeType` goes as a plain file. `Raw` bypasses the shape entirely and
 * reaches the platform as-is: the escape hatch for buttons, cards and
 * everything the verbs do not unify.
 */
export type OutboundBody = Data.TaggedEnum<{
  Text: { readonly text: string }
  Media: {
    readonly media: MediaSource
    readonly caption?: string
    readonly filename?: string
  }
  Raw: { readonly payload: unknown }
}>

export const OutboundBody = Data.taggedEnum<OutboundBody>()

/**
 * A body plus the envelope fields true of any message. `replyTo` is ignored
 * for a `Raw` body, which names its own wire fields.
 */
export type Outbound = {
  readonly body: OutboundBody
  readonly replyTo?: MessageId
}

export type OutboundOptions = { readonly replyTo?: MessageId }

const envelope = (body: OutboundBody, options?: OutboundOptions): Outbound => ({
  body,
  ...(options?.replyTo !== undefined && { replyTo: options.replyTo }),
})

/** Text message. The overwhelmingly common case: `post(text("hi"))`. */
export const text = (body: string, options?: OutboundOptions): Outbound =>
  envelope(OutboundBody.Text({ text: body }), options)

/** Media message. `caption` and `filename` describe the media, not the envelope. */
export const media = (
  source: MediaSource,
  options?: OutboundOptions & { readonly caption?: string; readonly filename?: string },
): Outbound =>
  envelope(
    OutboundBody.Media({
      media: source,
      ...(options?.caption !== undefined && { caption: options.caption }),
      ...(options?.filename !== undefined && { filename: options.filename }),
    }),
    options,
  )

/** Platform payload, passed through untouched. */
export const raw = (payload: unknown): Outbound => ({ body: OutboundBody.Raw({ payload }) })

// ---------------------------------------------------------------------------
// Ambient conversation targeting
// ---------------------------------------------------------------------------

/**
 * The conversation the outbound verbs target. A tag with no default, so
 * posting outside an established conversation is a compile error. Deep code
 * (a tool posting progress, an approval resolver) inherits it rather than
 * threading a ref down.
 */
export class CurrentConversation extends Context.Service<CurrentConversation, ConversationRef>()(
  "@betalyra/effect-uai/Messenger/CurrentConversation",
) {}

/** Run `effect` against `ref`. Wrap a conversation fiber once; every nested post lands. */
export const inConversation =
  (ref: ConversationRef) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentConversation>> =>
    Effect.provideService(effect, CurrentConversation, ref)

// ---------------------------------------------------------------------------
// Service definition
// ---------------------------------------------------------------------------

/** Envelope of a streamed reply. `replyTo` lands on the first message it posts. */
export type StreamOptions = OutboundOptions

/** Platform ceilings, so recipes can see them before composing a message. */
export type MessengerLimits = {
  /** Longest single text message. */
  readonly maxText: number
  /** Longest caption on a media message. */
  readonly maxCaption: number
}

/**
 * Cross-platform messaging: one inbound stream, five outbound verbs.
 *
 * `events` is single-consumer and provider-owned. The connection opens when
 * the layer is built and closes with its scope, so there is no connect /
 * disconnect here, and reconnects, acks and callback answering all happen
 * below this line.
 *
 * `post`, `typing` and `stream` target the ambient
 * {@link CurrentConversation}; `edit` and `react` name a message outright.
 */
export type MessengerService = {
  readonly events: Stream.Stream<InboundEvent, MessengerError.MessengerError>

  /** Text past `limits.maxText` goes out as several messages; the id is the last. */
  readonly post: (
    msg: Outbound,
  ) => Effect.Effect<MessageId, MessengerError.MessengerError, CurrentConversation>

  readonly edit: (
    msg: MessageRef,
    next: Outbound,
  ) => Effect.Effect<void, MessengerError.MessengerError>

  /**
   * `emoji` in the platform's own spelling, as its `Reaction` events deliver
   * it. Nothing is translated; one the platform rejects fails
   * `MessengerUnsupported`.
   */
  readonly react: (
    msg: MessageRef,
    emoji: string,
  ) => Effect.Effect<void, MessengerError.MessengerError>

  /** Activity indicator, kept alive by the adapter until the scope closes. */
  readonly typing: Effect.Effect<
    void,
    MessengerError.MessengerError,
    CurrentConversation | Scope.Scope
  >

  /**
   * Progressive delivery of a text stream; the mechanism is the adapter's.
   * The id is the last message posted, `None` when the stream had no text.
   */
  readonly stream: <E, R>(
    deltas: Stream.Stream<string, E, R>,
    options?: StreamOptions,
  ) => Effect.Effect<
    Option.Option<MessageId>,
    MessengerError.MessengerError | E,
    R | CurrentConversation
  >

  readonly limits: MessengerLimits
}

export class Messenger extends Context.Service<Messenger, MessengerService>()(
  "@betalyra/effect-uai/Messenger",
) {}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

export const events: Stream.Stream<InboundEvent, MessengerError.MessengerError, Messenger> =
  Stream.unwrap(Effect.map(Messenger, (m) => m.events))

export const post = (
  msg: Outbound,
): Effect.Effect<MessageId, MessengerError.MessengerError, Messenger | CurrentConversation> =>
  Effect.flatMap(Messenger, (m) => m.post(msg))

export const edit = (
  msg: MessageRef,
  next: Outbound,
): Effect.Effect<void, MessengerError.MessengerError, Messenger> =>
  Effect.flatMap(Messenger, (m) => m.edit(msg, next))

export const react = (
  msg: MessageRef,
  emoji: string,
): Effect.Effect<void, MessengerError.MessengerError, Messenger> =>
  Effect.flatMap(Messenger, (m) => m.react(msg, emoji))

export const typing: Effect.Effect<
  void,
  MessengerError.MessengerError,
  Messenger | CurrentConversation | Scope.Scope
> = Effect.flatMap(Messenger, (m) => m.typing)

export const stream = <E, R>(
  deltas: Stream.Stream<string, E, R>,
  options?: StreamOptions,
): Effect.Effect<
  Option.Option<MessageId>,
  MessengerError.MessengerError | E,
  R | Messenger | CurrentConversation
> => Effect.flatMap(Messenger, (m) => m.stream(deltas, options))
