---
title: Messenger
description: "Run your agent as a Telegram, Discord or Slack bot. One event stream in, five verbs out, and the chat it answers in is ambient, so every post lands in the right place."
icon: PiChatsCircle
---

You have an agent loop. The people who should use it are in Telegram,
Discord or Slack. `Messenger` connects the two: one stream of what people
say, five verbs for answering, and a provider layer per platform. Your loop,
tools and history stay as they are.

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

Providing the layer connects the bot; closing the scope disconnects it.
Swap the layer for [Discord](/messenger/providers/discord/) or
[Slack](/messenger/providers/slack/) and the program does not change.

## What arrives

`events` is one stream of everything people do:

- **`Message`**: someone wrote something. `addressed` says whether it was
  meant for the bot (a DM, an `@mention`, or a reply to one of its messages),
  and `text` has the bot's own mention stripped. Branch on `addressed`; the
  rest is group chatter.
- **`Command`**: `/search effect streams` as `name` and `args`.
- **`Reaction`**: an emoji on a message.
- **`Action`**: a button press, with its `actionId`.

Each carries `raw`, the platform's own payload, for the fields the shared
shape leaves out. Reconnects and acknowledgements happen for you; the stream
ends only when the connection is gone for good.

## What you can send

- **`post`** a message and get back its id.
- **`edit`** a message you posted.
- **`react`** to a message with an emoji in the platform's own spelling:
  unicode on Telegram and Discord, a shortcode on Slack. `Reaction` events
  arrive the same way.
- **`typing`** shows the indicator for as long as the scope is open.
- **`stream`** a `Stream<string>` and the reply appears as it is written,
  quoting the message in `replyTo` if you pass one. You get the last
  message's id back, or none when the stream had no text.

A message is text, media, or the platform's own payload:

```ts
Messenger.text("Done.", { replyTo: event.id })
Messenger.media(Image.imageBytes(png, "image/png"), { caption: "Here you go" })
Messenger.raw({ method: "sendMessage", params: { chat_id, text, reply_markup } })
```

Text goes out exactly as you wrote it. Platforms disagree on markup, so
nothing is converted: your system prompt tells the model which one to write,
and each provider page says which that is. `raw` reaches buttons, cards and
anything else the five verbs do not cover.

## Which chat

`post`, `typing` and `stream` take no chat id. They target the ambient
`CurrentConversation`, which you set once where a conversation starts:

```ts
conversation(inbox).pipe(Messenger.inConversation(event.conversation), Effect.forkScoped)
```

Everything under that line lands in that chat, including a tool posting
progress from inside `Toolkit.run`. Without it the code does not compile. To
reach another chat, re-scope:

```ts
yield * messenger.post(Messenger.text("On it, escalating."))
yield * messenger.post(Messenger.text(summary)).pipe(Messenger.inConversation(onCall))
```

## Streaming a reply

Hand `stream` the text deltas of a turn and the answer shows up as one
message that fills in as the model writes. Where the platform has no
streaming API, the provider posts once and edits in place, honouring rate
limits, and starts a new message when the answer outgrows the platform's
limit. The [messenger agent](/recipes/messenger-agent/) recipe is the full
shape: one loop per conversation, typing held for the turn, tools, history.

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
  reactions, media. Long-polling, no public URL.
- [Discord](/messenger/providers/discord/): DMs, mentions, threads, buttons,
  reactions, media. One gateway websocket, no public URL.
- [Slack](/messenger/providers/slack/): DMs, mentions, threads, slash
  commands, buttons, reactions, files. Socket Mode, no public URL.

Each runs as a long-lived process, one instance per bot. Webhook delivery,
which WhatsApp needs, is not there yet.
