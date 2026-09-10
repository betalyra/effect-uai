---
title: Telegram
description: "Run your agent as a Telegram bot: DMs, group mentions and commands in, streamed HTML replies, media and reactions out. Long-polling, so no public URL, and no SDK."
source: packages/providers/telegram
---

To run your agent as a Telegram bot you need a bot token and this package.
It long-polls the Bot API, so it works from a laptop or a container with no
public URL, and it uses no SDK.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/telegram effect
```

## Create the bot

Message [@BotFather](https://t.me/BotFather), send `/newbot`, and keep the
token it gives you.

If the bot should react to `@mentions` in groups, also send `/setprivacy`
and turn privacy mode **off** (then re-add the bot to the group), or make it
a group admin. With privacy mode on, Telegram delivers only commands, replies
to the bot and DMs, so a bare mention never arrives.

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

A wrong token fails here, as `MessengerConnectFailed`. From then on the bot
polls until the scope closes. Run one instance per token: Telegram refuses a
second poller and ends the first one's event stream.

The layer registers `Messenger`, plus the typed `Telegram` tag for code that
wants the bot's own `id` and `username`.

| Option        | Default            | What it does                                      |
| ------------- | ------------------ | ------------------------------------------------- |
| `token`       | required           | Bot token, `Redacted`.                            |
| `parseMode`   | `"HTML"`           | Markup for every text. `"plain"` sends none.      |
| `pollTimeout` | `30 seconds`       | How long each poll waits for something to happen. |
| `stream`      | `every: 1s`        | `every`, `minChars`, `rateLimitRetries`.          |
| `baseUrl`     | `api.telegram.org` | For a self-hosted Bot API server.                 |

## Tell the model to write HTML

Text is sent as you give it. Telegram does not accept the markdown models
write on their own (`MarkdownV2` wants every `. ! - ( )` escaped), so the
default mode is HTML and one line in your system prompt does the rest:

> Format replies as Telegram HTML: `<b>`, `<i>`, `<code>`, `<pre>`, `<a href>`.
> Escape `&`, `<`, `>` in prose. No markdown.

When the model slips and Telegram cannot parse a message, the same text is
resent plain: you lose the formatting on that message, not the message. While
streaming, an edit that lands mid-tag shows plain for a beat and renders once
the tag closes.

## Getting mentioned

`addressed` is true for a DM, an `@bot` mention (any case, stripped from
`text`), or a reply to one of the bot's messages. See privacy mode above for
what a group delivers at all.

## Commands

`/search@YourBot effect streams` arrives as `Command { name: "search", args: "effect streams" }`.
A `/word` in the middle of a sentence stays text, and a command meant for
another bot in the group is left alone. `/start` is an ordinary command; the
greeting is yours to write.

## Streaming

`stream` posts on the first words and edits the message as the answer grows:
about once a second, only when there is something new to show, with a final
edit for the tail and a fresh message once the answer passes 4096
characters. `stream` in the config tunes the pace.

If you call `edit` yourself: Telegram rejects an edit that changes nothing
(`message is not modified`), and you get it back as `MessengerRequestFailed`
like any other rejection. `stream` never sends unchanged text.

## Media

`Messenger.media(source, { caption, filename })` picks the endpoint from the
MIME type: images go as photos, `audio/*` as audio, `video/*` as video,
everything else as a document. A `url` source is fetched by Telegram; bytes
and base64 are uploaded. A URL without a `mimeType` goes as a document.
Editing a media message is `MessengerUnsupported`: send a new one.

## Reactions

`react` takes a unicode emoji from Telegram's fixed set of about seventy;
anything else is `MessengerUnsupported`. To receive reactions in a group the
bot must be an admin.

## Typing

`typing` keeps the indicator on until the scope you acquired it in closes.
Not available in channels.

## Buttons

A press on an inline keyboard button arrives as an `Action` with the
button's callback data as `actionId`. The provider answers the callback
query for you, so the client's spinner never waits on your code. Sending the
keyboard itself is `Messenger.raw`.

## Anything else

`Messenger.raw({ method, params })` calls any Bot API method as-is: inline
keyboards, polls, whatever the verbs do not cover. For `post`, the method
should return a message so an id comes back.

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
- `MessengerUnsupported`: an emoji off the set, editing media.
