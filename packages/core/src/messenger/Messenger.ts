import {
  Array as Arr,
  Brand,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Option,
  Schedule,
  type Scope,
  Stream,
} from "effect"
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

/**
 * Where a conversation happens. `thread` is opaque and provider-interpreted:
 * a Slack `thread_ts`, a Telegram forum topic id, unused on Discord (where a
 * thread is its own channel).
 */
export type ConversationRef = {
  readonly channel: ChannelId
  readonly thread?: string
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

  /** Unicode emoji. Platforms with a fixed set fail `MessengerUnsupported` off it. */
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

  /** Progressive delivery of a text stream; the mechanism is the adapter's. */
  readonly stream: <E, R>(
    deltas: Stream.Stream<string, E, R>,
  ) => Effect.Effect<MessageId, MessengerError.MessengerError | E, R | CurrentConversation>

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
): Effect.Effect<
  MessageId,
  MessengerError.MessengerError | E,
  R | Messenger | CurrentConversation
> => Effect.flatMap(Messenger, (m) => m.stream(deltas))

// ---------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------

// Paragraph break first, then line break, then space.
const boundaries = ["\n\n", "\n", " "] as const

/** Best split at or before `limit`; a hard cut only for an unbroken run. */
const cutAt = (body: string, limit: number): readonly [head: string, rest: string] =>
  body.length <= limit
    ? [body, ""]
    : Arr.findFirst(boundaries, (sep) =>
        Option.map(
          Option.liftPredicate(body.lastIndexOf(sep, limit - sep.length), (at) => at > 0),
          (at) => [body.slice(0, at), body.slice(at + sep.length)] as const,
        ),
      ).pipe(Option.getOrElse(() => [body.slice(0, limit), body.slice(limit)] as const))

/**
 * Chunk `body` into pieces no longer than `limit`, breaking on paragraph,
 * line, then word boundaries. Always yields at least one chunk, so callers
 * have something to send even for empty input.
 */
export const splitForLimit = (body: string, limit: number): Arr.NonEmptyReadonlyArray<string> => {
  const [head, rest] = cutAt(body, limit)
  return rest.length === 0 ? [head] : [head, ...splitForLimit(rest, limit)]
}

// ---------------------------------------------------------------------------
// streamViaEdits
// ---------------------------------------------------------------------------

/** The slice of a messenger that {@link streamViaEdits} drives. */
export type EditableVerbs = Pick<MessengerService, "post" | "edit" | "limits">

export type StreamViaEditsOptions = {
  /** Minimum wall time between edits. Default 1 second. */
  readonly every?: Duration.Input
  /** Minimum growth since the last edit before spending another. Default 40. */
  readonly minChars?: number
  /** How often to honour a `MessengerRateLimited` before giving up. Default 3. */
  readonly rateLimitRetries?: number
  /** Sent when the stream produced no text at all. Default `"…"`. */
  readonly placeholder?: string
}

const isRateLimited = (e: MessengerError.MessengerError): boolean =>
  e._tag === "MessengerRateLimited"

// A retry schedule's input is the error, so the delay is the platform's own
// `retry_after` rather than a guess. Bounded by `recurs`, so an unlucky call
// eventually surfaces the rate limit instead of stalling behind it.
const honourRetryAfter = (
  times: number,
): Schedule.Schedule<number, MessengerError.MessengerError> =>
  Schedule.recurs(times).pipe(
    Schedule.setInputType<MessengerError.MessengerError>(),
    Schedule.modifyDelay(({ input }) =>
      Effect.succeed(input._tag === "MessengerRateLimited" ? input.retryAfter : Duration.zero),
    ),
  )

/** The message being filled and what it already shows. */
type Progress = {
  readonly id: Option.Option<MessageId>
  /** Text the message shows now. Never resent unchanged. */
  readonly sent: string
  /** Text it should show, deltas included. */
  readonly pending: string
  readonly lastFlush: number
}

const start: Progress = { id: Option.none(), sent: "", pending: "", lastFlush: 0 }

const appended = (s: Progress, delta: string): Progress => ({
  ...s,
  pending: s.pending + delta,
})

const delivered = (s: Progress, id: MessageId, sent: string): Progress => ({
  ...s,
  id: Option.some(id),
  sent,
})

// A fresh message: nothing has been sent for it yet.
const rolledOver = (s: Progress, pending: string): Progress => ({
  ...s,
  id: Option.none(),
  sent: "",
  pending,
})

/**
 * Progressive delivery as post-then-edit, for adapters with no native
 * streaming API. Coalesces deltas by time and growth, never resends
 * unchanged text, waits out `MessengerRateLimited`, rolls over to a fresh
 * message past `limits.maxText`, and always flushes the tail.
 *
 * The first chunk goes out as soon as any text arrives, so the message shows
 * up immediately and fills in from there.
 */
export const streamViaEdits =
  (verbs: EditableVerbs, options?: StreamViaEditsOptions) =>
  <E, R>(
    deltas: Stream.Stream<string, E, R>,
  ): Effect.Effect<MessageId, MessengerError.MessengerError | E, R | CurrentConversation> =>
    Effect.gen(function* () {
      const every = Duration.toMillis(options?.every ?? "1 second")
      const minChars = options?.minChars ?? 40
      const placeholder = options?.placeholder ?? "…"
      const schedule = honourRetryAfter(options?.rateLimitRetries ?? 3)
      const conversation = yield* CurrentConversation

      const patiently = <A, R2>(
        effect: Effect.Effect<A, MessengerError.MessengerError, R2>,
      ): Effect.Effect<A, MessengerError.MessengerError, R2> =>
        Effect.retry(effect, { schedule, while: isRateLimited })

      // Post the first chunk, edit from then on, and skip an edit that would
      // resend what the message already shows.
      const deliver = (
        s: Progress,
        body: string,
      ): Effect.Effect<
        readonly [MessageId, Progress],
        MessengerError.MessengerError,
        CurrentConversation
      > =>
        Option.match(s.id, {
          onNone: () =>
            patiently(verbs.post(text(body))).pipe(
              Effect.map((id) => [id, delivered(s, id, body)] as const),
            ),
          onSome: (id) =>
            body === s.sent
              ? Effect.succeed([id, s] as const)
              : patiently(verbs.edit({ conversation, id }, text(body))).pipe(
                  Effect.as([id, delivered(s, id, body)] as const),
                ),
        })

      // Anything past the ceiling becomes the next message: finish the current
      // one at a clean boundary, then start over on the remainder.
      const rollover = (
        s: Progress,
      ): Effect.Effect<Progress, MessengerError.MessengerError, CurrentConversation> => {
        const [head, rest] = cutAt(s.pending, verbs.limits.maxText)
        return rest.length === 0
          ? Effect.succeed(s)
          : deliver(s, head).pipe(Effect.flatMap(([, next]) => rollover(rolledOver(next, rest))))
      }

      // The first chunk lands on arrival; later ones wait for both gates.
      const due = (s: Progress, now: number): boolean =>
        Option.isNone(s.id)
          ? s.pending.length > 0
          : now - s.lastFlush >= every && s.pending.length - s.sent.length >= minChars

      const step = (before: Progress, delta: string) =>
        rollover(appended(before, delta)).pipe(
          Effect.flatMap((s) =>
            Effect.flatMap(Clock.currentTimeMillis, (now) =>
              due(s, now)
                ? Effect.map(deliver(s, s.pending), ([, flushed]) => ({
                    ...flushed,
                    lastFlush: now,
                  }))
                : Effect.succeed(s),
            ),
          ),
        )

      // The tail always lands, and a turn that produced no text at all still
      // owes the caller a message id.
      return yield* Stream.runFoldEffect(deltas, () => start, step).pipe(
        Effect.flatMap(rollover),
        Effect.flatMap((s) =>
          deliver(s, Option.isNone(s.id) && s.pending.length === 0 ? placeholder : s.pending),
        ),
        Effect.map(([id]) => id),
      )
    })
