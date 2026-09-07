---
title: Telegram
description: "Run your agent as a Telegram bot: DMs, group mentions and commands in, streamed HTML replies, media and reactions out. Long-polling, so no public URL, and no SDK."
source: packages/providers/telegram
---

A bot token from [@BotFather](https://t.me/BotFather) is all Telegram asks
for. This provider registers the `Messenger` capability over the Bot API on
Effect's `HttpClient`: it long-polls for updates, so it runs anywhere with
outbound internet, and it needs no grammY or telegraf.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/telegram effect
```

## Wire it up

```ts
import { Effect, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { layer as telegramLayer } from "@effect-uai/telegram/Telegram"

const provider = telegramLayer({ token: Redacted.make(process.env.TELEGRAM_BOT_TOKEN!) })

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(provider), Effect.provide(NodeHttpClient.layerUndici)),
)
```

A wrong token fails right here, as `MessengerConnectFailed`. From then on the
bot is polling until the scope closes. Run **one instance per token**: a
second poller is refused by Telegram and ends the first one's event stream.

The layer registers `Messenger` and, for code that wants the bot's own
`id` and `username`, the typed `Telegram` tag.

| Option        | Default                   | What it does                                      |
| ------------- | ------------------------- | ------------------------------------------------- |
| `token`       | required                  | Bot token, `Redacted`.                            |
| `parseMode`   | `"HTML"`                  | Markup for every text. `"plain"` sends none.      |
| `pollTimeout` | `30 seconds`              | How long each poll waits for something to happen. |
| `stream`      | `streamViaEdits` defaults | `every`, `minChars`, `rateLimitRetries`.          |
| `baseUrl`     | `api.telegram.org`        | For a self-hosted Bot API server.                 |

## Tell the model to write HTML

Text is sent as you give it. Telegram does not accept the markdown models
write on their own (`MarkdownV2` wants every `. ! - ( )` escaped), so the
default mode is HTML and one line in your system prompt does the rest:

> Format replies as Telegram HTML: `<b>`, `<i>`, `<code>`, `<pre>`, `<a href>`.
> Escape `&`, `<`, `>` in prose. No markdown.

When the model slips and Telegram cannot parse a message, the same text is
resent plain, so you lose formatting on that message, not the message. While
streaming, an edit that lands mid-tag shows plain for a beat and renders once
the tag closes.

## Getting mentioned in groups

Out of the box, Telegram's **privacy mode** is on: in a group your bot only
sees commands, replies to its own messages, and DMs. A bare `@bot` mention is
never delivered, so it cannot count as `addressed`. To be mentioned, turn
privacy off with BotFather's `/setprivacy` (then re-add the bot to the
group), or make the bot a group admin.

`addressed` is true for a DM, an `@bot` mention (any case, stripped from
`text`), or a reply to one of the bot's messages.

## Commands

`/search@YourBot effect streams` arrives as `Command { name: "search", args: "effect streams" }`.
A `/word` in the middle of a sentence stays text, and a command meant for
another bot in the group is left alone. `/start` is an ordinary command; the
greeting is yours to write.

## Streaming

Telegram has no native streaming in groups, so `stream` posts on the first
words and edits the message as the answer grows: about once a second, only
when there is something new to show, with a final edit for the tail, and a
fresh message once the answer passes 4096 characters. `stream` in the config
tunes the pace.

One Telegram quirk to know if you call `edit` yourself: an edit that changes
nothing is rejected (`message is not modified`), and you get it back as
`MessengerRequestFailed` like any other rejection. `stream` never sends
unchanged text, so it never meets it.

## Media

`Messenger.media(source, { caption, filename })` picks the endpoint from the
MIME type: images go as photos, `audio/*` as audio, `video/*` as video, and
everything else as a document. A `url` source is fetched by Telegram; bytes
and base64 are uploaded. A URL without a `mimeType` goes as a document.
Editing a media message is `MessengerUnsupported`: send a new one.

## Reactions

`react` uses Telegram's fixed set of about seventy emoji; anything else is
`MessengerUnsupported`. To _receive_ reactions in a group the bot must be an
admin; the provider already asks Telegram to deliver them.

## Typing

`typing` keeps the indicator on until the scope you acquired it in closes.
Not available in channels.

## Anything else

`Messenger.raw({ method, params })` calls any Bot API method as-is. Inline
keyboards, polls, ephemeral messages: this is the door. For `post`, the
method should return a message so an id comes back.

## Chats and threads

Chat ids arrive as numeric strings (`"-1001234567890"` for a supergroup). A
forum topic is a `thread`; a reply chain is not, and stays in the chat's
conversation.

## Errors

- `MessengerConnectFailed`: the token was refused at wiring time.
- `MessengerTransportClosed`: dead token, or a second poller took over.
  Network hiccups and 429s are retried quietly.
- `MessengerRateLimited`: Telegram asked you to wait; `retryAfter` says how long.
- `MessengerRequestFailed`: anything else Telegram rejected, with its reason.
- `MessengerUnsupported`: reaction emoji off the set, editing media.
