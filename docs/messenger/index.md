---
title: Messenger
description: "Put your agent where people already talk. One event stream in, five verbs out, and the conversation it answers in is ambient, so every post lands in the right chat."
icon: PiChatsCircle
---

You have an agent. It runs in a terminal, or behind an HTTP route. The
people who would use it are in Telegram, Slack or Discord, and they are not
coming to your terminal. `Messenger` puts the agent in their chat: it reads
what people say, it types, it streams its answer back, and the loop you
already wrote does not change.

## Quickstart

An echo bot, end to end:

```ts
import { Effect, Redacted, Stream } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import * as Messenger from "@effect-uai/core/Messenger"
import { layer as telegramLayer } from "@effect-uai/telegram/Telegram"

const echo = Effect.gen(function* () {
  const messenger = yield* Messenger.Messenger
  yield* Stream.runForEach(messenger.events, (event) =>
    event._tag === "Message" && event.addressed
      ? messenger
          .post(Messenger.text(`You said: ${event.text}`, { replyTo: event.id }))
          .pipe(Messenger.inConversation(event.conversation))
      : Effect.void,
  )
})

await Effect.runPromise(
  echo.pipe(
    Effect.scoped,
    Effect.provide(telegramLayer({ token: Redacted.make(process.env.TELEGRAM_BOT_TOKEN!) })),
    Effect.provide(NodeHttpClient.layerUndici),
  ),
)
```

Provide the layer and the bot is connected; close the scope and it is gone.
There is nothing to start or stop by hand.

## What arrives

`events` is one stream of everything people do:

- **`Message`**: someone wrote something. `text` has the bot's own mention
  stripped, and `addressed` tells you whether it was meant for the bot: a
  DM, an `@mention`, or a reply to one of its messages. That flag is what
  you branch on; everything else is group chatter you can ignore.
- **`Command`**: `/search effect streams` as `name` and `args`.
- **`Reaction`**: an emoji on a message.
- **`Action`**: a button press, with its `actionId`.

Each carries `raw`, the platform's own payload, when you need a field the
shared shape does not have. Reconnects and acknowledgements happen for you;
the stream only ends when the connection is gone for good.

## What you can send

- **`post`** a message, and get back its id.
- **`edit`** a message you posted.
- **`react`** to a message with an emoji.
- **`typing`** shows the indicator for as long as the scope is open.
- **`stream`** a `Stream<string>` and the reply appears as it is written. You
  get the last message's id back, or none if the stream had no text.

A message is text, media or the platform's own payload:

```ts
Messenger.text("Done.", { replyTo: event.id })
Messenger.media(Image.imageBytes(png, "image/png"), { caption: "Here you go" })
Messenger.raw({ method: "sendMessage", params: { chat_id, text, reply_markup } })
```

Text goes out **exactly as you wrote it**. Platforms disagree on markup
(Telegram wants HTML, Slack takes markdown), so the library does not
convert; your system prompt tells the model which one to write, and each
provider page says which that is. `raw` is the door to buttons, cards and
anything else the five verbs do not cover.

## Which chat

`post`, `typing` and `stream` do not take a chat id. They target the
ambient `CurrentConversation`, which you set once where a conversation
starts:

```ts
conversation(inbox).pipe(Messenger.inConversation(event.conversation), Effect.forkScoped)
```

Everything under that line, down to a tool posting progress from inside
`Toolkit.run`, lands in that chat. Forget to set it and the code does not
compile. To reach another chat, re-scope:

```ts
yield * messenger.post(Messenger.text("On it, escalating."))
yield * messenger.post(Messenger.text(summary)).pipe(Messenger.inConversation(onCall))
```

## Streaming a reply

Hand `stream` the text deltas of a turn and the answer shows up as one
message that fills in as the model writes. Where the platform has no native
streaming, the adapter posts once and edits in place, rate limits included,
and starts a new message if the answer outgrows the platform's limit. The
[messenger agent](/recipes/messenger-agent/) recipe is the full shape: an
agentic loop per conversation, typing held for the turn, tools, history.

## When it fails

Every verb fails with a `MessengerError`: `RequestFailed` (the platform said
no, with its reason), `RateLimited` (with how long to wait), `Unsupported`
(this platform cannot do that), `ConnectFailed` (bad token, at wiring time)
and `TransportClosed` (the events stream is over).

## Testing

`@effect-uai/core/testing/MockMessenger` replays a scripted event stream and
records every post, edit and reaction, so a bot's behaviour is a unit test.

## Providers

- [Telegram](/messenger/providers/telegram/): DMs, groups, commands,
  reactions, media. Long-polling, no public URL needed.

Discord and Slack are next. All three are long-lived processes with one
instance per bot token; webhook delivery, which WhatsApp needs, comes later.
