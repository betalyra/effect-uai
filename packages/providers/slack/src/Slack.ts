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
} from "@effect-uai/core/Messenger"
import {
  type StreamViaEditsOptions,
  splitForLimit,
  streamViaEdits,
} from "@effect-uai/core/MessengerAdapter"
import * as MessengerError from "@effect-uai/core/MessengerError"
import * as Api from "./internal/api.js"
import * as Events from "./internal/events.js"
import * as SocketMode from "./internal/socket.js"

export type { BotIdentity, ReplyIn } from "./internal/events.js"
export { classifyDisconnect, type DisconnectAction } from "./internal/socket.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Config = Api.Config & {
  /**
   * Where a top-level mention is answered. Default `"thread"`, which keeps a
   * conversation out of the channel and lets follow-ups inside it map back.
   */
  readonly replyIn?: Events.ReplyIn
  /** Tuning for `stream`, which is post-then-edit on Slack. */
  readonly stream?: StreamViaEditsOptions
}

export type SlackService = MessengerService & {
  /** From `auth.test` at layer build: the identity behind `addressed`. */
  readonly bot: Events.BotIdentity
}

/**
 * Provider-typed tag. Yield this for the bot identity; yield the generic
 * `Messenger` tag for provider-portable code. Both are registered by {@link layer}.
 */
export class Slack extends Context.Service<Slack, SlackService>()(
  "@betalyra/effect-uai/providers/slack/Slack",
) {}

/** `markdown_text` allows far more, but a chat message past this is unreadable. */
export const limits: MessengerLimits = { maxText: 4000, maxCaption: 4000 }

// `chat.update` is Tier 3, so an edit a second is comfortably inside it.
const defaultStream: StreamViaEditsOptions = { every: "1200 millis" }

// ---------------------------------------------------------------------------
// Wire results
// ---------------------------------------------------------------------------

const AuthTest = Schema.Struct({
  user_id: Schema.String,
  bot_id: Schema.String,
  team_id: Schema.String,
})
const Opened = Schema.Struct({ url: Schema.String })
const Posted = Schema.Struct({ ts: Schema.String })
const UploadUrl = Schema.Struct({ upload_url: Schema.String, file_id: Schema.String })

// `shares` nests visibility, then channel, then the messages the file appears in.
const Shares = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, Schema.Array(Schema.Struct({ ts: Schema.optional(Schema.String) }))),
)
const Completed = Schema.Struct({
  files: Schema.Array(Schema.Struct({ id: Schema.String, shares: Schema.optional(Shares) })),
})
type Completed = typeof Completed.Type

const RawCall = Schema.Struct({
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

/** The message a file was shared as, when Slack reports one. */
const shareTs = (uploaded: Completed): Option.Option<string> =>
  Arr.head(uploaded.files).pipe(
    Option.flatMap((file) =>
      Arr.findFirst(
        Object.values(file.shares ?? {}).flatMap((byChannel) => Object.values(byChannel).flat()),
        (share) => share.ts !== undefined,
      ),
    ),
    Option.flatMap((share) => Option.fromNullishOr(share.ts)),
  )

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const isApiFailure = (e: Api.ApiError): e is Api.ApiFailure => e._tag === "SlackApiFailure"

const fails = (needle: string) => (e: Api.ApiError) => isApiFailure(e) && e.error === needle

const reasonOf = (e: Api.ApiError): string => (isApiFailure(e) ? e.error : "rate limited")

/** An API rejection becomes the verb's `MessengerRequestFailed`; typed errors pass through. */
const requestFailed =
  (operation: MessengerError.MessengerOperation) =>
  (e: Api.ApiError | MessengerError.MessengerError): MessengerError.MessengerError =>
    Match.value(e).pipe(
      Match.tag(
        "SlackApiFailure",
        (failure) =>
          new MessengerError.MessengerRequestFailed({
            provider: Api.provider,
            operation,
            reason: failure.error,
            raw: failure.raw,
          }),
      ),
      Match.orElse((typed) => typed),
    )

const unsupported = (capability: string, reason: string) =>
  new MessengerError.MessengerUnsupported({ provider: Api.provider, capability, reason })

// ---------------------------------------------------------------------------
// Outbound params
// ---------------------------------------------------------------------------

type MediaFields = Extract<OutboundBody, { _tag: "Media" }>

/**
 * Slack's "reply" is posting in the thread, so a `replyTo` outside one opens a
 * thread on that message and inside one is already named by the conversation.
 */
const target = (at: ConversationRef, msg: Outbound): Api.Params => {
  const thread = at.thread ?? msg.replyTo
  return { channel: at.channel, ...(thread !== undefined && { thread_ts: thread }) }
}

const defaultFilename = (media: MediaSource): string =>
  `file.${media.mimeType?.split("/")[1] ?? "bin"}`

const invalidMedia = (raw: unknown) =>
  new MessengerError.MessengerRequestFailed({
    provider: Api.provider,
    operation: "post",
    reason: "invalid base64 media",
    raw,
  })

// `:eyes:` and `eyes` name the same reaction; Slack wants it bare. Only the
// outer colons go, so a skin tone modifier survives.
const shortcode = (emoji: string): string => emoji.replace(/^:|:$/g, "")

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<
  SlackService,
  MessengerError.MessengerConnectFailed,
  HttpClient.HttpClient | Scope.Scope
> =>
  Effect.gen(function* () {
    // Captured once so the verbs need no `HttpClient` of their own.
    const client = yield* HttpClient.HttpClient
    const withClient = Effect.provideService(HttpClient.HttpClient, client)
    const call = (method: string, params?: Api.Params) => withClient(Api.call(cfg)(method, params))
    const query = (method: string, params: Api.Params) => withClient(Api.query(cfg)(method, params))

    const connectFailed = (e: Api.ApiError) =>
      new MessengerError.MessengerConnectFailed({
        provider: Api.provider,
        reason: reasonOf(e),
        raw: isApiFailure(e) ? e.raw : e,
      })

    // A bad bot token fails here rather than as a socket close a moment later.
    const identity = yield* call("auth.test").pipe(
      Api.decoded("auth.test", AuthTest),
      Effect.mapError(connectFailed),
    )
    const bot: Events.BotIdentity = {
      userId: identity.user_id,
      botId: identity.bot_id,
      teamId: identity.team_id,
    }

    // -- inbound -----------------------------------------------------------

    // Each connection needs its own single-use URL, so this runs again on
    // every reconnect. The app token is used nowhere else.
    const open = withClient(Api.callAsApp(cfg)("apps.connections.open")).pipe(
      Api.decoded("apps.connections.open", Opened),
      Effect.map(({ url }) => url),
      Effect.mapError(
        (e): MessengerError.MessengerError =>
          new MessengerError.MessengerConnectFailed({
            provider: Api.provider,
            reason: reasonOf(e),
            raw: isApiFailure(e) ? e.raw : e,
          }),
      ),
    )

    const session = yield* SocketMode.connect({ open })
    const toEvents = Events.toEvents({ bot, replyIn: cfg.replyIn ?? "thread" })
    const inbox = yield* Queue.unbounded<InboundEvent, MessengerError.MessengerError | Cause.Done>()

    yield* Stream.fromQueue(session.envelopes).pipe(
      Stream.runForEach(({ envelope, raw }) => Queue.offerAll(inbox, toEvents(envelope, raw))),
      Effect.catch((closed) => Queue.fail(inbox, closed)),
      Effect.ensuring(Queue.end(inbox)),
      Effect.forkScoped,
    )

    // -- outbound ----------------------------------------------------------

    const sendRaw = (payload: unknown) =>
      Effect.gen(function* () {
        const { method, params } = yield* Schema.decodeUnknownEffect(RawCall)(payload).pipe(
          Effect.mapError(
            () =>
              new MessengerError.MessengerRequestFailed({
                provider: Api.provider,
                operation: "post",
                reason: "raw payload must be { method, params? }",
                raw: payload,
              }),
          ),
        )
        return yield* call(method, params)
      })

    // A URL is not a Slack upload, so it goes as the link and Slack unfurls it.
    const sendUrl = (at: ConversationRef, msg: Outbound, body: MediaFields, url: string) =>
      call("chat.postMessage", {
        ...target(at, msg),
        markdown_text: Arr.getSomes([Option.fromNullishOr(body.caption), Option.some(url)]).join(
          "\n",
        ),
      }).pipe(
        Api.decoded("chat.postMessage", Posted),
        Effect.map(({ ts }) => ts),
      )

    // Three steps: reserve a URL, put the bytes there, then share the file into
    // the conversation with the caption as its comment.
    const sendBytes = (
      at: ConversationRef,
      msg: Outbound,
      body: MediaFields,
      bytes: Uint8Array,
      mimeType: string,
    ) =>
      Effect.gen(function* () {
        const filename = body.filename ?? defaultFilename(body.media)
        const reserved = yield* query("files.getUploadURLExternal", {
          filename,
          length: bytes.length,
        }).pipe(Api.decoded("files.getUploadURLExternal", UploadUrl))
        yield* withClient(Api.upload(reserved.upload_url, { bytes, filename, mimeType }))
        const uploaded = yield* call("files.completeUploadExternal", {
          files: [{ id: reserved.file_id, title: filename }],
          channel_id: at.channel,
          ...target(at, msg),
          ...(body.caption !== undefined && { initial_comment: body.caption }),
        }).pipe(Api.decoded("files.completeUploadExternal", Completed))
        // A share reports the message it became; without one the file id is
        // the only handle there is, and a file message cannot be edited anyway.
        return Option.getOrElse(shareTs(uploaded), () => reserved.file_id)
      })

    const sendMedia = (at: ConversationRef, msg: Outbound, body: MediaFields) =>
      Match.value(body.media).pipe(
        Match.tag("url", ({ url }) => sendUrl(at, msg, body, url)),
        Match.tag("bytes", ({ bytes, mimeType }) => sendBytes(at, msg, body, bytes, mimeType)),
        Match.tag("base64", ({ base64, mimeType }) =>
          Effect.fromResult(Encoding.decodeBase64(base64)).pipe(
            Effect.mapError(invalidMedia),
            Effect.flatMap((bytes) => sendBytes(at, msg, body, bytes, mimeType)),
          ),
        ),
        Match.exhaustive,
      )

    // Every chunk lands in the same thread, so only the id of the last matters.
    const sendChunks = (at: ConversationRef, msg: Outbound, body: string) =>
      Effect.gen(function* () {
        const [first, ...rest] = splitForLimit(body, limits.maxText)
        const send = (chunk: string) =>
          call("chat.postMessage", { ...target(at, msg), markdown_text: chunk }).pipe(
            Api.decoded("chat.postMessage", Posted),
            Effect.map(({ ts }) => ts),
          )
        const head = yield* send(first)
        const tail = yield* Effect.forEach(rest, send)
        return Option.getOrElse(Arr.last(tail), () => head)
      })

    const post: MessengerService["post"] = (msg) =>
      Effect.gen(function* () {
        const at = yield* CurrentConversation
        const ts = yield* Match.value(msg.body).pipe(
          Match.tag("Text", ({ text }) => sendChunks(at, msg, text)),
          Match.tag("Media", (body) => sendMedia(at, msg, body)),
          Match.tag("Raw", ({ payload }) =>
            sendRaw(payload).pipe(
              Api.decoded("raw", Posted),
              Effect.map(({ ts }) => ts),
            ),
          ),
          Match.exhaustive,
        )
        return MessageId(ts)
      }).pipe(Effect.mapError(requestFailed("post")))

    const edit: MessengerService["edit"] = (ref, next) =>
      Match.value(next.body).pipe(
        Match.tag("Text", ({ text }) =>
          call("chat.update", {
            channel: ref.conversation.channel,
            ts: ref.id,
            markdown_text: text,
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

    // The shortcode is the same spelling a `Reaction` event delivers.
    const react: MessengerService["react"] = (ref, emoji) =>
      call("reactions.add", {
        channel: ref.conversation.channel,
        timestamp: ref.id,
        name: shortcode(emoji),
      }).pipe(
        Effect.asVoid,
        Effect.catchIf(fails("invalid_name"), () =>
          Effect.fail(unsupported("reaction", `${emoji} is not an emoji this workspace has`)),
        ),
        Effect.mapError(requestFailed("react")),
      )

    /**
     * Best effort: Slack shows a session status on its agent surfaces only, so
     * a rejection is logged and swallowed rather than taking a turn down.
     */
    const typing: MessengerService["typing"] = Effect.gen(function* () {
      const at = yield* CurrentConversation
      const status = (state: string) =>
        call("agents.sessions.setStatus", {
          channel_id: at.channel,
          ...(at.thread !== undefined && { thread_ts: at.thread }),
          status: state,
        }).pipe(
          Effect.asVoid,
          Effect.catch((e) => Effect.logDebug("slack status not set", { reason: reasonOf(e) })),
        )
      yield* Effect.acquireRelease(status("processing"), () => status("active"))
    })

    return {
      bot,
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
 * One Socket Mode connection, registered under both the `Slack` and
 * `Messenger` tags. Building the layer authenticates and waits for `hello`, so
 * a rejected token fails here; the connection lives until the scope closes and
 * `events` ends with it.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<Slack | Messenger, MessengerError.MessengerConnectFailed, HttpClient.HttpClient> =>
  Layer.effectContext(
    Effect.map(make(cfg), (service) =>
      Context.make(Slack, service).pipe(Context.add(Messenger, service)),
    ),
  )
