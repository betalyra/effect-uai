---
title: Discord
description: "Run your agent as a Discord bot: DMs, channel mentions and threads in, streamed markdown replies, media and reactions out. Gateway websocket, no public URL, and no discord.js."
source: packages/providers/discord
---

To run your agent as a Discord bot you need an application with a bot token
and this package. It holds one gateway websocket, so it works from a laptop
or a container with no public URL, and it uses no discord.js.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/discord effect
```

## Create the bot

1. In the [developer portal](https://discord.com/developers/applications),
   **New Application**, then **Bot** in the sidebar. **Reset Token** shows
   the token once; keep it.
2. Leave the privileged intents off. Discord fills in message content for
   DMs and for messages that mention the bot without them. Turn **Message
   Content** on only if the bot should read channel chatter it was not
   addressed in; above 10,000 users Discord makes you apply for it.
3. **OAuth2 → URL generator**, scope `bot`, permissions **Send Messages**,
   **Read Message History** and **Add Reactions**. Open the URL and pick a
   server.

## Wire it up

```ts
import { Effect, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { layer as discordLayer } from "@effect-uai/discord/Discord"

const provider = discordLayer({ token: Redacted.make(process.env.DISCORD_BOT_TOKEN!) })

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(provider), Effect.provide(NodeHttpClient.layerUndici)),
)
```

Building the layer connects to the gateway and waits for Discord's `READY`,
so a wrong token or an intent the portal has not granted fails here, as
`MessengerConnectFailed`. From then on the session is live until the scope
closes. Run one instance per token: a second one gets its own session and
both answer every message.

The layer registers `Messenger`, plus the typed `Discord` tag for code that
wants the bot's own `id` and `username`.

| Option    | Default                            | What it does                             |
| --------- | ---------------------------------- | ---------------------------------------- |
| `token`   | required                           | Bot token, `Redacted`.                   |
| `intents` | mention/DM set, no privileged bits | Gateway intents mask.                    |
| `stream`  | `every: 1.2s`                      | `every`, `minChars`, `rateLimitRetries`. |
| `baseUrl` | `discord.com/api/v10`              | For a proxy in front of the API.         |

`Discord.Intents` has the bits and `Discord.defaultIntents` the default
mask, so reading all channel messages is
`intents: Discord.defaultIntents | Discord.Intents.MessageContent`.

## Tell the model to write markdown

Text is sent as you give it. Discord's markdown is close enough to what
models write on their own that one line in your system prompt is enough:

> Format replies as markdown: `**bold**`, `*italic*`, `` `code` ``, fenced
> code blocks and bare links. No HTML.

Every post and edit goes out with `allowed_mentions: { parse: [] }`, so
nothing the model writes can ping a person, a role or `@everyone`.

## Getting mentioned

`addressed` is true for a DM, an `@mention` of the bot, or a reply to one of
its messages. `@everyone` and role pings do not count, the bot's own mention
is stripped from `text`, and messages written by any bot are dropped, so two
bots cannot talk each other in circles.

Two things to know in a server:

- A reply to the bot counts as addressed, but without the Message Content
  intent its `text` is empty, because Discord only fills content for DMs and
  mentions. Design for `@mention`, or turn the intent on.
- When you mention the bot yourself, pick it from the `@` autocomplete under
  **MEMBERS**. Discord creates a role with the same name beside every bot,
  and that entry pings the role, which does not address the bot.

## Commands

Nothing arrives as a `Command` on Discord. There is no `/start`; a
conversation begins with the first DM or mention. Slash commands are not
supported yet.

## Threads

A Discord thread is a channel of its own, so a thread's `ConversationRef` is
its channel id with `thread` unset. State keyed on `conversationKey`
separates a thread from its parent channel for free.

## Streaming

Discord has no streaming API, so `stream` posts on the first words and edits
the message as the answer grows: about every 1.2 seconds, which stays under
Discord's edit rate limit, only when there is something new to show, with a
final edit for the tail and a fresh message once the answer passes 2000
characters. `stream` in the config tunes the pace.

## Media

`Messenger.media(source, { caption, filename })` uploads bytes and base64 as
an attachment. Discord cannot attach a URL, so a `url` source goes as the
message text for Discord to unfurl. Editing a media message is
`MessengerUnsupported`: send a new one.

## Reactions

`react` takes a unicode emoji, or `name:id` for a custom one, which is how a
`Reaction` event arrives too. An emoji Discord does not know comes back as
`MessengerUnsupported`.

## Typing

`typing` keeps the indicator on until the scope you acquired it in closes.

## Buttons

A button press arrives as an `Action` with the component's `custom_id` as
`actionId` and a select's values comma-joined into `value`. The provider
answers Discord's three-second interaction deadline for you, with an
acknowledgement that changes nothing on screen. Sending the buttons
themselves is `Messenger.raw`.

## Anything else

`Messenger.raw({ method, path, body })` calls any v10 endpoint as-is. For
`post`, the response must carry an `id` so one comes back.

## Reconnects

Heartbeats, resumes and reconnects happen for you, with a capped backoff; a
session that stops acknowledging heartbeats is closed and resumed. None of
that reaches `events`. Only a close Discord says not to retry (a rejected
token, an invalid or disallowed intent, a bad API version, a sharding
demand) ends the stream, as `MessengerTransportClosed` naming the code.

## Errors

- `MessengerConnectFailed`: the token was refused, or the gateway rejected
  the handshake, at wiring time.
- `MessengerTransportClosed`: a gateway close reconnecting cannot fix.
- `MessengerRateLimited`: a 429; `retryAfter` is Discord's `retry_after`.
- `MessengerRequestFailed`: anything else Discord rejected, with its message
  and error code.
- `MessengerUnsupported`: an emoji Discord does not know, editing media.
