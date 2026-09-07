---
title: Telegram
description: "Run an agent as a Telegram bot over the Bot API: long-poll getUpdates for events, HTML-formatted replies, and post-then-edit streaming. No SDK."
source: packages/providers/telegram
---

The Telegram provider registers the core `Messenger` capability over the
[Bot API](https://core.telegram.org/bots/api). It is plain JSON over HTTPS on
Effect's `HttpClient`: no grammY, no telegraf. Inbound events come from a
long-poll `getUpdates` loop the layer owns; replies go out through
`sendMessage`, `editMessageText`, `setMessageReaction` and the media
endpoints.

Good fit for: a bot you can DM or mention, with streamed answers. Not this
package: webhooks (a later phase), inline mode, payments.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/telegram effect
```

## Wire it up

Get a token from [@BotFather](https://t.me/BotFather), then:

```ts
import { Effect, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { layer as telegramLayer } from "@effect-uai/telegram/Telegram"

const provider = telegramLayer({ token: Redacted.make(process.env.TELEGRAM_BOT_TOKEN!) })

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(provider), Effect.provide(NodeHttpClient.layerUndici)),
)
```

Building the layer calls `getMe` (a bad token fails here with
`MessengerConnectFailed`) and starts the poll loop in the layer's scope. When
the scope closes the loop stops and `events` ends. Telegram allows **one
poller per token**: a second instance gets `409 Conflict`, which the adapter
surfaces as `MessengerTransportClosed`.

`telegramLayer` registers two tags from one implementation: `Telegram` (typed,
adds `bot: { id, username }`) and the generic `Messenger`.

### Config

| Option        | Default          | What it does                                                          |
| ------------- | ---------------- | --------------------------------------------------------------------- |
| `token`       | required         | Bot token, `Redacted`.                                                |
| `parseMode`   | `"HTML"`         | `parse_mode` sent with every text. `"plain"` sends none.              |
| `pollTimeout` | `30 seconds`     | Long-poll wait per `getUpdates` call.                                 |
| `stream`      | `streamViaEdits` defaults | `every`, `minChars`, `rateLimitRetries`, `placeholder`.     |
| `baseUrl`     | `api.telegram.org` | For a local Bot API server.                                        |

## Formatting: prompt for HTML

`Text` bodies are sent verbatim under `parseMode`. Telegram does not accept
the markdown models write by default (`MarkdownV2` needs every `. ! - ( )`
escaped), so the default is HTML and the system prompt is where the model
learns it:

> Format replies as Telegram HTML: `<b>`, `<i>`, `<code>`, `<pre>`, `<a href>`.
> Escape `&`, `<`, `>` in prose. No markdown.

If Telegram still rejects a message (`400 can't parse entities`), the adapter
resends the same text with no `parse_mode`, so a stray `<` costs formatting
on that message, not the message. While streaming, an edit that lands
mid-tag takes that fallback for one tick and the next edit renders formatted.

## Privacy mode

With BotFather's default privacy mode **on**, a bot in a group receives only
commands, replies to its own messages and DMs. A bare `@bot` mention is not
delivered, so `addressed` can never be true for it. For mention-to-address
UX, either `/setprivacy` to off (then re-add the bot to the group) or make
the bot a group admin.

`addressed` is true for a private chat, a `@bot` mention (case-insensitive,
stripped from `text`), or a reply to one of the bot's messages.

## Commands

A `bot_command` entity at offset 0 becomes `Command { name, args }` with any
`@bot` suffix removed: `/search@MyBot effect streams` is `name: "search"`,
`args: "effect streams"`. A `/word` mid-sentence stays part of a `Message`,
and a command aimed at another bot (`/start@OtherBot`) is not claimed.
`/start` goes through the same rule; greeting on it is the recipe's job.

## Streaming

Telegram has no native streaming in groups, so `stream` is
`Messenger.streamViaEdits`: `sendMessage` on the first delta, then
`editMessageText` at most once per second and only after 40 new characters,
a final edit for the tail, and a new message past 4096 characters. Tune via
`stream` in the config.

**No-op edits are not swallowed.** Telegram rejects an edit that changes
nothing (`400 message is not modified`) and the adapter surfaces it as
`MessengerRequestFailed`, as it does every rejection. `streamViaEdits` never
sends unchanged text, so you only meet this calling `edit` yourself.

`sendMessageDraft` (animated drafts in private chats) is a follow-up.

## Media

`Messenger.media(source, { caption, filename })` routes on the MIME type:
`image/*` to `sendPhoto`, `audio/*` to `sendAudio`, `video/*` to `sendVideo`,
anything else to `sendDocument`. A `url` source is passed through for
Telegram to fetch; `base64` and `bytes` are uploaded as multipart. A URL with
no `mimeType` goes as a document. Editing a media message is
`MessengerUnsupported`; send a new one.

## Reactions

`react` sends `setMessageReaction`. Telegram allows a fixed set of about
seventy emoji; anything else comes back as `MessengerUnsupported`. Receiving
reactions (`message_reaction` updates) is requested via `allowed_updates` on
every poll, and in groups additionally needs the bot to be an admin.

## Typing

`sendChatAction` lasts about five seconds, so `typing` re-sends it every
four until the scope it was acquired in closes. Not available in channels.

## Raw

`Messenger.raw({ method, params })` calls any Bot API method with the given
params and expects a `Message` back (for `post`) or nothing in particular
(for `edit`). Inline keyboards, polls, ephemeral messages: this is the door.

## Threads

`ConversationRef.thread` is the forum topic id (`message_thread_id` on a
topic message). Reply chains have no thread id and stay in the chat's
conversation. Chat ids are numeric strings (`"-1001234567890"` for a
supergroup).

## Errors

- `MessengerConnectFailed`: `getMe` failed at layer build.
- `MessengerTransportClosed`: 401 (dead token) or 409 (second poller).
  Everything else, including 429 and network errors, is retried with
  backoff inside the poller.
- `MessengerRateLimited`: `retry_after` from a 429, as a `Duration`.
- `MessengerRequestFailed`: any other rejection, `reason` is Telegram's
  `description`.
- `MessengerUnsupported`: off-set reaction emoji, media edits.
