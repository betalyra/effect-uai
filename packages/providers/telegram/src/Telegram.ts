import {
  Array as Arr,
  type Cause,
  Context,
  Duration,
  Effect,
  Encoding,
  Layer,
  Match,
  Option,
  Queue,
  Ref,
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
import * as Api from "./internal/api.js"
import * as Events from "./internal/events.js"

export type { BotIdentity } from "./internal/events.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Telegram's own markup modes. `Text` bodies are sent verbatim under one. */
export type ParseMode = "HTML" | "MarkdownV2" | "Markdown"

export type Config = Api.Config & {
  /**
   * Markup the model is prompted to write. Default `"HTML"`; `"plain"` sends
   * text with no `parse_mode` at all.
   */
  readonly parseMode?: ParseMode | "plain"
  /** Long-poll wait per `getUpdates` call. Default 30 seconds. */
  readonly pollTimeout?: Duration.Input
  /** Tuning for `stream`, which is post-then-edit on Telegram. */
  readonly stream?: StreamViaEditsOptions
}

export type TelegramService = MessengerService & {
  /** From `getMe` at layer build: the identity behind `addressed`. */
  readonly bot: Events.BotIdentity
}

/**
 * Provider-typed tag. Yield this for the bot identity; yield the generic
 * `Messenger` tag for provider-portable code. Both are registered by {@link layer}.
 */
export class Telegram extends Context.Service<Telegram, TelegramService>()(
  "@betalyra/effect-uai/providers/telegram/Telegram",
) {}

export const limits: MessengerLimits = { maxText: 4096, maxCaption: 1024 }

// ---------------------------------------------------------------------------
// Wire results
// ---------------------------------------------------------------------------

const Me = Schema.Struct({ id: Schema.Number, username: Schema.String })
const Sent = Schema.Struct({ message_id: Schema.Number })
const Updates = Schema.Array(Events.Update)
const RawCall = Schema.Struct({ method: Schema.String, params: Schema.optional(Schema.Unknown) })

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const isApiFailure = (e: Api.ApiError): e is Api.ApiFailure => e._tag === "TelegramApiFailure"

const describes = (needle: string) => (e: Api.ApiError) =>
  isApiFailure(e) && e.description.includes(needle)

const reasonOf = (e: Api.ApiError): string => (isApiFailure(e) ? e.description : "rate limited")

/** An API rejection becomes the verb's `MessengerRequestFailed`; typed errors pass through. */
const requestFailed =
  (operation: MessengerError.MessengerOperation) =>
  (e: Api.ApiError | MessengerError.MessengerError): MessengerError.MessengerError =>
    Match.value(e).pipe(
      Match.tag(
        "TelegramApiFailure",
        (failure) =>
          new MessengerError.MessengerRequestFailed({
            provider: Api.provider,
            operation,
            reason: failure.description,
            raw: failure.raw,
          }),
      ),
      Match.orElse((typed) => typed),
    )

const unsupported = (capability: string, reason: string) =>
  new MessengerError.MessengerUnsupported({ provider: Api.provider, capability, reason })

// 401 is a dead token and 409 a second poller on it; nothing else ends the stream.
const isFatalPoll = (e: Api.ApiError) => isApiFailure(e) && (e.code === 401 || e.code === 409)

// Transient poll failures wait five seconds, or exactly what a 429 asked for.
const pollBackoff: Schedule.Schedule<number, Api.ApiError> = Schedule.forever.pipe(
  Schedule.setInputType<Api.ApiError>(),
  Schedule.modifyDelay(({ input }) =>
    Effect.succeed(input._tag === "MessengerRateLimited" ? input.retryAfter : Duration.seconds(5)),
  ),
)

// ---------------------------------------------------------------------------
// Outbound params
// ---------------------------------------------------------------------------

const target = (at: ConversationRef): Api.Params => ({
  chat_id: at.channel,
  ...(at.thread !== undefined && { message_thread_id: Number(at.thread) }),
})

const replyParams = (msg: Outbound): Api.Params =>
  msg.replyTo === undefined ? {} : { reply_parameters: { message_id: Number(msg.replyTo) } }

const parseParams = (cfg: Config): Api.Params =>
  cfg.parseMode === "plain" ? {} : { parse_mode: cfg.parseMode ?? "HTML" }

type MediaRoute = { readonly method: string; readonly field: string }

/** The endpoint a `MediaSource` goes through, decided by its MIME type. */
const mediaRoute = (media: MediaSource): MediaRoute =>
  Match.value(media.mimeType ?? "").pipe(
    Match.when(
      (m) => m.startsWith("image/"),
      (): MediaRoute => ({ method: "sendPhoto", field: "photo" }),
    ),
    Match.when(
      (m) => m.startsWith("audio/"),
      (): MediaRoute => ({ method: "sendAudio", field: "audio" }),
    ),
    Match.when(
      (m) => m.startsWith("video/"),
      (): MediaRoute => ({ method: "sendVideo", field: "video" }),
    ),
    Match.orElse((): MediaRoute => ({ method: "sendDocument", field: "document" })),
  )

const defaultFilename = (media: MediaSource): string =>
  `file.${media.mimeType?.split("/")[1] ?? "bin"}`

const invalidMedia = (raw: unknown) =>
  new MessengerError.MessengerRequestFailed({
    provider: Api.provider,
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
  TelegramService,
  MessengerError.MessengerConnectFailed,
  HttpClient.HttpClient | Scope.Scope
> =>
  Effect.gen(function* () {
    // Captured once so the verbs need no `HttpClient` of their own.
    const client = yield* HttpClient.HttpClient
    const withClient = Effect.provideService(HttpClient.HttpClient, client)
    const call = (method: string, params?: Api.Params) => withClient(Api.call(cfg)(method, params))
    const upload = (method: string, params: Api.Params, file: Api.Upload) =>
      withClient(Api.upload(cfg)(method, params, file))

    const bot = yield* call("getMe").pipe(
      Api.decoded("getMe", Me),
      Effect.mapError(
        (e) =>
          new MessengerError.MessengerConnectFailed({
            provider: Api.provider,
            reason: reasonOf(e),
            raw: e.raw,
          }),
      ),
    )

    // -- inbound -----------------------------------------------------------

    const inbox = yield* Queue.unbounded<InboundEvent, MessengerError.MessengerError | Cause.Done>()
    const offset = yield* Ref.make(0)
    const toEvents = Events.toEvents(bot)

    // Answered before the event is offered, so the client's spinner never
    // waits on the recipe.
    const acknowledge = (update: Events.Update) =>
      Match.value(update).pipe(
        Match.when({ callback_query: Match.defined }, ({ callback_query }) =>
          call("answerCallbackQuery", { callback_query_id: callback_query.id }).pipe(Effect.ignore),
        ),
        Match.orElse(() => Effect.void),
      )

    const poll = Effect.gen(function* () {
      const updates = yield* call("getUpdates", {
        offset: yield* Ref.get(offset),
        timeout: Duration.toSeconds(cfg.pollTimeout ?? "30 seconds"),
        allowed_updates: Events.allowedUpdates,
      }).pipe(Api.decoded("getUpdates", Updates))
      yield* Effect.forEach(updates, (update) =>
        Effect.gen(function* () {
          yield* Ref.set(offset, update.update_id + 1)
          yield* acknowledge(update)
          yield* Queue.offerAll(inbox, toEvents(update))
        }),
      )
    })

    // Transient failures (network, 5xx, 429) back off and poll again; fatal
    // ones end the stream with `MessengerTransportClosed`.
    yield* poll.pipe(
      Effect.retry({ while: (e) => !isFatalPoll(e), schedule: pollBackoff }),
      Effect.forever,
      Effect.catch((e) =>
        Queue.fail(
          inbox,
          new MessengerError.MessengerTransportClosed({
            provider: Api.provider,
            reason: reasonOf(e),
            raw: e.raw,
          }),
        ),
      ),
      Effect.ensuring(Queue.end(inbox)),
      Effect.forkScoped,
    )

    // -- outbound ----------------------------------------------------------

    // Telegram rejects markup it cannot parse; the same text then goes out plain.
    const sendText = (method: string, params: Api.Params) =>
      call(method, { ...params, ...parseParams(cfg) }).pipe(
        Effect.catchIf(describes("can't parse entities"), () => call(method, params)),
      )

    const sendMedia = (
      at: ConversationRef,
      msg: Outbound,
      body: Extract<OutboundBody, { _tag: "Media" }>,
    ) => {
      const { method, field } = mediaRoute(body.media)
      const params = {
        ...target(at),
        ...replyParams(msg),
        ...(body.caption !== undefined && { caption: body.caption, ...parseParams(cfg) }),
      }
      const send = (bytes: Uint8Array, mimeType: string) =>
        upload(method, params, {
          field,
          bytes,
          filename: body.filename ?? defaultFilename(body.media),
          mimeType,
        })
      return Match.value(body.media).pipe(
        Match.tag("url", ({ url }) => call(method, { ...params, [field]: url })),
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
        return yield* call(method, (params ?? {}) as Api.Params)
      })

    // The reply lands on the first chunk; the id is the last one's.
    const sendChunks = (at: ConversationRef, msg: Outbound, text: string) =>
      Effect.gen(function* () {
        const [first, ...rest] = splitForLimit(text, limits.maxText)
        const send = (chunk: string, extra: Api.Params) =>
          sendText("sendMessage", { ...target(at), ...extra, text: chunk }).pipe(
            Api.decoded("sendMessage", Sent),
          )
        const head = yield* send(first, replyParams(msg))
        const tail = yield* Effect.forEach(rest, (chunk) => send(chunk, {}))
        return Option.getOrElse(Arr.last(tail), () => head)
      })

    const post: MessengerService["post"] = (msg) =>
      Effect.gen(function* () {
        const at = yield* CurrentConversation
        const sent = yield* Match.value(msg.body).pipe(
          Match.tag("Text", ({ text }) => sendChunks(at, msg, text)),
          Match.tag("Media", (body) =>
            sendMedia(at, msg, body).pipe(Api.decoded("sendMedia", Sent)),
          ),
          Match.tag("Raw", ({ payload }) => sendRaw(payload).pipe(Api.decoded("raw", Sent))),
          Match.exhaustive,
        )
        return MessageId(String(sent.message_id))
      }).pipe(Effect.mapError(requestFailed("post")))

    const edit: MessengerService["edit"] = (ref, next) =>
      Match.value(next.body).pipe(
        Match.tag("Text", ({ text }) =>
          sendText("editMessageText", {
            chat_id: ref.conversation.channel,
            message_id: Number(ref.id),
            text,
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

    // Telegram allows a fixed emoji set; anything else is REACTION_INVALID.
    const react: MessengerService["react"] = (ref, emoji) =>
      call("setMessageReaction", {
        chat_id: ref.conversation.channel,
        message_id: Number(ref.id),
        reaction: [{ type: "emoji", emoji }],
      }).pipe(
        Effect.asVoid,
        Effect.mapError(requestFailed("react")),
        Effect.catchIf(
          (e) => e._tag === "MessengerRequestFailed" && e.reason.includes("REACTION_INVALID"),
          () => Effect.fail(unsupported("reaction", `${emoji} is not in Telegram's reaction set`)),
        ),
      )

    // The indicator lasts about five seconds, so it is re-sent every four
    // until the scope closes. The first send is awaited so a bad chat fails here.
    const typing: MessengerService["typing"] = Effect.gen(function* () {
      const at = yield* CurrentConversation
      const once = call("sendChatAction", { ...target(at), action: "typing" })
      yield* once.pipe(Effect.mapError(requestFailed("typing")))
      yield* once.pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced("4 seconds")),
        Effect.forkScoped,
      )
    })

    return {
      bot,
      events: Stream.fromQueue(inbox),
      post,
      edit,
      react,
      typing,
      stream: streamViaEdits({ post, edit, limits }, cfg.stream),
      limits,
    }
  })

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * One poller, registered under both the `Telegram` and `Messenger` tags. The
 * long-poll loop starts when the layer is built and stops when its scope
 * closes; `events` ends with it. Telegram allows one poller per token.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<
  Telegram | Messenger,
  MessengerError.MessengerConnectFailed,
  HttpClient.HttpClient
> =>
  Layer.effectContext(
    Effect.map(make(cfg), (service) =>
      Context.make(Telegram, service).pipe(Context.add(Messenger, service)),
    ),
  )
