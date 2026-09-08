import {
  Array as Arr,
  type Cause,
  Context,
  Effect,
  Encoding,
  Layer,
  Match,
  Option,
  Queue,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { HttpClient } from "effect/unstable/http"
import type { MediaSource } from "@effect-uai/core/Media"
import {
  CurrentConversation,
  type ConversationRef,
  type InboundEvent,
  MessageId,
  Messenger,
  type MessengerLimits,
  type MessengerService,
  type Outbound,
  type OutboundBody,
  type StreamViaEditsOptions,
  splitForLimit,
  streamViaEdits,
} from "@effect-uai/core/Messenger"
import * as MessengerError from "@effect-uai/core/MessengerError"
import * as Events from "./internal/events.js"
import * as Gateway from "./internal/gateway.js"
import * as Rest from "./internal/rest.js"

export type { BotIdentity } from "./internal/events.js"
export { classifyClose, type CloseAction } from "./internal/gateway.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Gateway intent bits. `MessageContent` is the one Discord gates behind review. */
export const Intents = {
  Guilds: 1 << 0,
  GuildMessages: 1 << 9,
  GuildMessageReactions: 1 << 10,
  DirectMessages: 1 << 12,
  DirectMessageReactions: 1 << 13,
  MessageContent: 1 << 15,
} as const

/**
 * What a mention-or-DM bot needs. Even without the privileged
 * `MessageContent` intent, `content` arrives for DMs and for messages that
 * mention the bot, which is exactly the set `addressed` covers.
 */
export const defaultIntents: number =
  Intents.Guilds |
  Intents.GuildMessages |
  Intents.GuildMessageReactions |
  Intents.DirectMessages |
  Intents.DirectMessageReactions

export type Config = Rest.Config & {
  /** Gateway intents mask. Defaults to {@link defaultIntents}. */
  readonly intents?: number
  /** Tuning for `stream`, which is post-then-edit on Discord. */
  readonly stream?: StreamViaEditsOptions
}

export type DiscordService = MessengerService & {
  /** From `READY` at layer build: the identity behind `addressed`. */
  readonly bot: Events.BotIdentity
}

/**
 * Provider-typed tag. Yield this for the bot identity; yield the generic
 * `Messenger` tag for provider-portable code. Both are registered by {@link layer}.
 */
export class Discord extends Context.Service<Discord, DiscordService>()(
  "@betalyra/effect-uai/providers/discord/Discord",
) {}

export const limits: MessengerLimits = { maxText: 2000, maxCaption: 2000 }

// Under the observed five-edits-per-five-seconds-per-channel bucket.
const defaultStream: StreamViaEditsOptions = { every: "1200 millis" }

// A deferred update: the interaction is answered, nothing changes on screen.
const DEFERRED_UPDATE = 6

// ---------------------------------------------------------------------------
// Wire results
// ---------------------------------------------------------------------------

const Me = Schema.Struct({ id: Schema.String, username: Schema.String })
const Sent = Schema.Struct({ id: Schema.String })
const RawCall = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "PATCH", "PUT", "DELETE"]),
  path: Schema.String,
  body: Schema.optional(Schema.Unknown),
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const isApiFailure = (e: Rest.ApiError): e is Rest.ApiFailure => e._tag === "DiscordApiFailure"

const describes = (needle: string) => (e: Rest.ApiError) =>
  isApiFailure(e) && e.message.includes(needle)

const reasonOf = (e: Rest.ApiError): string => (isApiFailure(e) ? e.message : "rate limited")

/** An API rejection becomes the verb's `MessengerRequestFailed`; typed errors pass through. */
const requestFailed =
  (operation: MessengerError.MessengerOperation) =>
  (e: Rest.ApiError | MessengerError.MessengerError): MessengerError.MessengerError =>
    Match.value(e).pipe(
      Match.tag(
        "DiscordApiFailure",
        (failure) =>
          new MessengerError.MessengerRequestFailed({
            provider: Rest.provider,
            operation,
            reason: failure.message,
            raw: failure.raw,
          }),
      ),
      Match.orElse((typed) => typed),
    )

const unsupported = (capability: string, reason: string) =>
  new MessengerError.MessengerUnsupported({ provider: Rest.provider, capability, reason })

// ---------------------------------------------------------------------------
// Outbound params
// ---------------------------------------------------------------------------

type Fields = Rest.Fields

type MediaFields = Extract<OutboundBody, { _tag: "Media" }>

// Model output must never be able to ping anyone, so nothing is ever parsed.
const noMentions: Fields = { allowed_mentions: { parse: [] } }

const replyFields = (msg: Outbound): Fields =>
  msg.replyTo === undefined
    ? {}
    : { message_reference: { message_id: msg.replyTo, fail_if_not_exists: false } }

const messages = (at: ConversationRef): string => `/channels/${at.channel}/messages`

const captionField = (caption: string | undefined): Fields =>
  caption === undefined ? {} : { content: caption }

const defaultFilename = (media: MediaSource): string =>
  `file.${media.mimeType?.split("/")[1] ?? "bin"}`

const invalidMedia = (raw: unknown) =>
  new MessengerError.MessengerRequestFailed({
    provider: Rest.provider,
    operation: "post",
    reason: "invalid base64 media",
    raw,
  })

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<
  DiscordService,
  MessengerError.MessengerConnectFailed,
  HttpClient.HttpClient | Scope.Scope
> =>
  Effect.gen(function* () {
    // Captured once so the verbs need no `HttpClient` of their own.
    const client = yield* HttpClient.HttpClient
    const withClient = Effect.provideService(HttpClient.HttpClient, client)
    const call = (method: Rest.Method, path: string, body?: unknown) =>
      withClient(Rest.call(cfg)(method, path, body))
    const upload = (path: string, payload: Fields, file: Rest.Upload) =>
      withClient(Rest.upload(cfg)(path, payload, file))

    const connectFailed = (e: Rest.ApiError) =>
      new MessengerError.MessengerConnectFailed({
        provider: Rest.provider,
        reason: reasonOf(e),
        raw: isApiFailure(e) ? e.raw : e,
      })

    // A bad token fails here rather than as a gateway close a moment later.
    yield* call("GET", "/users/@me").pipe(
      Rest.decoded("GET /users/@me", Me),
      Effect.mapError(connectFailed),
    )
    const { url } = yield* call("GET", "/gateway/bot").pipe(
      Rest.decoded("GET /gateway/bot", Gateway.GatewayInfo),
      Effect.mapError(connectFailed),
    )

    // -- inbound -----------------------------------------------------------

    const session = yield* Gateway.connect({
      token: cfg.token,
      intents: cfg.intents ?? defaultIntents,
      url,
    })
    const toEvents = Events.toEvents(session.bot)
    const inbox = yield* Queue.unbounded<InboundEvent, MessengerError.MessengerError | Cause.Done>()

    // Discord drops a component interaction that goes unanswered for three
    // seconds, so it is acknowledged in the reader fiber rather than by the
    // recipe, the twin of Telegram's `answerCallbackQuery`.
    const acknowledge = (dispatch: Events.Dispatch) =>
      Match.value(dispatch).pipe(
        Match.when({ t: "INTERACTION_CREATE" }, ({ d }) =>
          d.type === Events.MESSAGE_COMPONENT
            ? call("POST", `/interactions/${d.id}/${d.token}/callback`, {
                type: DEFERRED_UPDATE,
              }).pipe(Effect.ignore)
            : Effect.void,
        ),
        Match.orElse(() => Effect.void),
      )

    yield* Stream.fromQueue(session.dispatches).pipe(
      Stream.runForEach(({ dispatch, raw }) =>
        acknowledge(dispatch).pipe(Effect.andThen(Queue.offerAll(inbox, toEvents(dispatch, raw)))),
      ),
      Effect.catch((closed) => Queue.fail(inbox, closed)),
      Effect.ensuring(Queue.end(inbox)),
      Effect.forkScoped,
    )

    // -- outbound ----------------------------------------------------------

    const sendRaw = (payload: unknown) =>
      Effect.gen(function* () {
        const { method, path, body } = yield* Schema.decodeUnknownEffect(RawCall)(payload).pipe(
          Effect.mapError(
            () =>
              new MessengerError.MessengerRequestFailed({
                provider: Rest.provider,
                operation: "post",
                reason: "raw payload must be { method, path, body? }",
                raw: payload,
              }),
          ),
        )
        return yield* call(method, path, body)
      })

    // Discord has no attachment-by-URL, so a URL goes as content and Discord
    // unfurls it. Not as an embed: embeds need the Embed Links permission and
    // are silently stripped without it, which Discord then rejects as an
    // empty message.
    const sendUrl = (at: ConversationRef, fields: Fields, body: MediaFields, url: string) =>
      call("POST", messages(at), {
        ...fields,
        content: Arr.getSomes([Option.fromNullishOr(body.caption), Option.some(url)]).join("\n"),
      })

    const sendMedia = (at: ConversationRef, msg: Outbound, body: MediaFields) => {
      const fields = { ...noMentions, ...replyFields(msg) }
      const send = (bytes: Uint8Array, mimeType: string) =>
        upload(
          messages(at),
          { ...fields, ...captionField(body.caption) },
          { bytes, filename: body.filename ?? defaultFilename(body.media), mimeType },
        )
      return Match.value(body.media).pipe(
        Match.tag("url", ({ url }) => sendUrl(at, fields, body, url)),
        Match.tag("bytes", ({ bytes, mimeType }) => send(bytes, mimeType)),
        Match.tag("base64", ({ base64, mimeType }) =>
          Effect.fromResult(Encoding.decodeBase64(base64)).pipe(
            Effect.mapError(invalidMedia),
            Effect.flatMap((bytes) => send(bytes, mimeType)),
          ),
        ),
        Match.exhaustive,
      )
    }

    // The reply lands on the first chunk; the id is the last one's.
    const sendChunks = (at: ConversationRef, msg: Outbound, text: string) =>
      Effect.gen(function* () {
        const [first, ...rest] = splitForLimit(text, limits.maxText)
        const send = (chunk: string, extra: Fields) =>
          call("POST", messages(at), { ...noMentions, ...extra, content: chunk }).pipe(
            Rest.decoded("POST message", Sent),
          )
        const head = yield* send(first, replyFields(msg))
        const tail = yield* Effect.forEach(rest, (chunk) => send(chunk, {}))
        return Option.getOrElse(Arr.last(tail), () => head)
      })

    const post: MessengerService["post"] = (msg) =>
      Effect.gen(function* () {
        const at = yield* CurrentConversation
        const sent = yield* Match.value(msg.body).pipe(
          Match.tag("Text", ({ text }) => sendChunks(at, msg, text)),
          Match.tag("Media", (body) =>
            sendMedia(at, msg, body).pipe(Rest.decoded("POST media", Sent)),
          ),
          Match.tag("Raw", ({ payload }) => sendRaw(payload).pipe(Rest.decoded("raw", Sent))),
          Match.exhaustive,
        )
        return MessageId(sent.id)
      }).pipe(Effect.mapError(requestFailed("post")))

    const edit: MessengerService["edit"] = (ref, next) =>
      Match.value(next.body).pipe(
        Match.tag("Text", ({ text }) =>
          call("PATCH", `${messages(ref.conversation)}/${ref.id}`, {
            ...noMentions,
            content: text,
          }).pipe(Effect.asVoid, Effect.mapError(requestFailed("edit"))),
        ),
        Match.tag("Raw", ({ payload }) =>
          sendRaw(payload).pipe(Effect.asVoid, Effect.mapError(requestFailed("edit"))),
        ),
        Match.tag("Media", () =>
          Effect.fail(unsupported("media edits", "send a new message instead")),
        ),
        Match.exhaustive,
      )

    // Unicode emoji go URL-encoded and custom ones as `name:id`, which is the
    // same spelling a `Reaction` event delivers.
    const react: MessengerService["react"] = (ref, emoji) =>
      call(
        "PUT",
        `${messages(ref.conversation)}/${ref.id}/reactions/${encodeURIComponent(emoji)}/@me`,
      ).pipe(
        Effect.asVoid,
        Effect.catchIf(describes("Unknown Emoji"), () =>
          Effect.fail(unsupported("reaction", `${emoji} is not an emoji Discord knows`)),
        ),
        Effect.mapError(requestFailed("react")),
      )

    // The indicator lasts ten seconds, so it is re-sent every eight until the
    // scope closes. The first send is awaited so a bad channel fails here.
    const typing: MessengerService["typing"] = Effect.gen(function* () {
      const at = yield* CurrentConversation
      const once = call("POST", `/channels/${at.channel}/typing`)
      yield* once.pipe(Effect.mapError(requestFailed("typing")))
      yield* once.pipe(
        Effect.ignore,
        Effect.schedule(Schedule.spaced("8 seconds")),
        Effect.forkScoped,
      )
    })

    return {
      bot: session.bot,
      events: Stream.fromQueue(inbox),
      post,
      edit,
      react,
      typing,
      stream: streamViaEdits({ post, edit, limits }, { ...defaultStream, ...cfg.stream }),
      limits,
    }
  })

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * One gateway session, registered under both the `Discord` and `Messenger`
 * tags. Building the layer identifies and waits for `READY`, so a bad token
 * or an intent the portal has not granted fails here; the connection lives
 * until the scope closes and `events` ends with it. Run one instance per
 * bot token.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<Discord | Messenger, MessengerError.MessengerConnectFailed, HttpClient.HttpClient> =>
  Layer.effectContext(
    Effect.map(make(cfg), (service) =>
      Context.make(Discord, service).pipe(Context.add(Messenger, service)),
    ),
  )
