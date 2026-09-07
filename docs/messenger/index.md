---
title: Messenger
description: "The inbound capability: one event stream from a chat platform, five outbound verbs to answer on it, and an ambient conversation so deep code posts to the right place."
icon: PiChatCircleDots
---

Every other capability is outbound: the agent searches, reads, browses,
executes. `Messenger` is where the world talks to the agent. One provider
layer, and the agentic loop you already have lives in a Telegram chat, a
Discord channel or a Slack thread.

## Quickstart

```ts
import { Effect, Redacted, Stream } from "effect"
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

The connection opens when the layer is built and closes with the scope.
There is no `connect` or `disconnect`; the `Layer` is the lifecycle.

## Inbound

`events` is a `Stream<InboundEvent>`, single-consumer. Four variants:

- **`Message`**: text from a person. `addressed` is true for a DM, a mention
  of the bot, or a reply to one of its messages; `text` arrives with the
  bot's own mention stripped.
- **`Command`**: a slash command (`/search effect streams`) as `name` and the
  raw `args` string.
- **`Reaction`**: an emoji added to a message.
- **`Action`**: a button press or similar, with its `actionId`.

Every variant carries `raw`, the untouched platform payload, and a
`ConversationRef` (`channel`, and a provider-interpreted `thread` where one
exists). `Messenger.conversationKey(ref)` is the stable string to index
per-conversation state by.

Routine reconnects, acknowledgements and callback answering happen inside
the adapter. The stream fails with `MessengerTransportClosed` only when the
transport is gone for good.

## Outbound

Five verbs, all failing with a `MessengerError`:

- **`post(msg)`** sends a message and returns its `MessageId`. Text past
  `limits.maxText` goes out as several messages; the id is the last one's.
- **`edit(ref, next)`** replaces a message you can name.
- **`react(ref, emoji)`** adds a unicode emoji.
- **`typing`** turns on the activity indicator and keeps it on until the
  enclosing scope closes.
- **`stream(deltas)`** delivers a `Stream<string>` progressively and returns
  the id of the message it ended up in. How is the adapter's business:
  native streaming where the platform has it, post-then-edit elsewhere.

`limits` (`maxText`, `maxCaption`) exposes the platform ceilings.

### What a message is

```ts
Messenger.text("Done.", { replyTo: event.id })
Messenger.media(Image.imageBytes(png, "image/png"), { caption: "Here you go" })
Messenger.raw({ method: "sendMessage", params: { chat_id, text, reply_markup } })
```

An `Outbound` is a body plus the envelope fields true of any message
(`replyTo` today). `Text` is **sent verbatim**: the library does not convert
markup. Each provider page says what its layer expects (Telegram HTML by
default, Slack markdown), and your system prompt is where the model learns
it. `Media` takes a core `MediaSource` (URL, base64 or bytes) and routes on
its MIME type. `Raw` is the escape hatch for buttons, cards and anything the
verbs do not unify.

## Where does it go

`post`, `typing` and `stream` target the ambient `CurrentConversation`, a
context tag with no default. Establish it once at a fiber boundary:

```ts
conversation(inbox).pipe(Messenger.inConversation(event.conversation), Effect.forkScoped)
```

Everything below that line, including a tool posting progress from inside
`Toolkit.run`, lands in that conversation. Posting outside one is a compile
error, not a runtime surprise. Re-scope to reach another chat:

```ts
yield* messenger.post(Messenger.text("On it, escalating."))
yield* messenger.post(Messenger.text(summary)).pipe(Messenger.inConversation(onCallChannel))
```

## Streaming a turn

The [messenger agent](/recipes/messenger-agent/) recipe is the whole shape:
tap a turn's text deltas into a queue, hand the queue to `stream`, hold
`typing` in the iteration's scope. Adapters without a native streaming API
use `Messenger.streamViaEdits`, which coalesces deltas by time and growth,
never resends unchanged text, waits out `MessengerRateLimited`, and rolls
over to a new message past `limits.maxText`.

## Errors

`MessengerConnectFailed` (layer build), `MessengerTransportClosed` (the
stream is over), `MessengerRequestFailed` (a verb was rejected, with the
platform's `reason`), `MessengerRateLimited` (with `retryAfter`), and
`MessengerUnsupported` (this platform cannot do it). `MessengerError.describe`
turns any of them into a log line.

## Testing

`@effect-uai/core/testing/MockMessenger` replays a scripted `events` stream
and records every outbound call. Recipe tests run against it with no network.

## Providers

- [Telegram](/messenger/providers/telegram/): long-poll `getUpdates`, one
  HTTP client, no SDK.

Discord (gateway) and Slack (Socket Mode) follow. Webhook-mode transports,
which WhatsApp requires, are a later phase: v1 is a long-lived process with
one instance per bot token.
