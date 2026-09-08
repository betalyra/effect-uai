---
title: Discord
description: "Run your agent as a Discord bot: DMs, channel mentions and threads in, streamed markdown replies, media and reactions out. Gateway websocket, no public URL, and no discord.js."
source: packages/providers/discord
---

A bot token from the [developer portal](https://discord.com/developers/applications)
is all Discord asks for. This provider registers the `Messenger` capability
over the gateway and the v10 REST API on Effect's `HttpClient` and `Socket`:
it holds one websocket, so it runs anywhere with outbound internet, and it
needs no discord.js or `discord-api-types`.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/discord effect
```

## Set the bot up

1. **Create the application.** Developer portal, **New Application**, then
   **Bot** in the sidebar. **Reset Token** gives you the token; it is shown
   once.
2. **Leave the privileged intents off.** A mention-or-DM agent does not need
   **Message Content**: Discord populates `content` for DMs and for messages
   that mention the bot regardless. Turn it on only if you want to read
   channel chatter the bot was not addressed in, and note that above 10,000
   users Discord makes you apply for it.
3. **Invite it.** **OAuth2 → URL generator**, scope `bot`, permissions
   `Send Messages`, `Read Message History` and `Add Reactions`. Open the URL
   and pick a server.

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

Building the layer identifies against the gateway and waits for `READY`, so a
wrong token or an intent the portal has not granted fails right here as
`MessengerConnectFailed`. From then on the session is live until the scope
closes. Run **one instance per token**: a second one gets its own session and
both answer every message.

The layer registers `Messenger` and, for code that wants the bot's own `id`
and `username`, the typed `Discord` tag.

| Option    | Default                            | What it does                             |
| --------- | ---------------------------------- | ---------------------------------------- |
| `token`   | required                           | Bot token, `Redacted`.                   |
| `intents` | mention/DM set, no privileged bits | Gateway intents mask.                    |
| `stream`  | `every: 1.2s`                      | `every`, `minChars`, `rateLimitRetries`. |
| `baseUrl` | `discord.com/api/v10`              | For a proxy in front of the API.         |

`Discord.Intents` has the bits, and `Discord.defaultIntents` the default mask,
so adding message content is
`intents: Discord.defaultIntents | Discord.Intents.MessageContent`.

## Tell the model to write markdown

Text is sent as you give it, with no parse mode: Discord's markdown is close
enough to what models write on their own that one line in your system prompt
is enough.

> Format replies as Discord markdown: `**bold**`, `*italic*`, `` `code` ``,
> fenced code blocks and bare links. No HTML.

Every post and edit goes out with `allowed_mentions: { parse: [] }`, so
nothing the model writes can ping a person, a role or `@everyone`.

## Getting mentioned

`addressed` is true for a DM, an `@mention` of the bot, or a reply to one of
its messages. `@everyone` and role pings do not count, and the bot's own
mention is stripped from `text` before you see it. Messages written by any
bot, including this one, are dropped before they reach the stream, so two
bots cannot talk each other in circles.

Replies need more than the mention rule. Discord fills `content` only for DMs
and mentions, so without `MessageContent` a reply arrives `addressed: true`
with an empty `text`, and it needs **Read Message History** to register as
addressed at all. In a server, design for `@mention` unless you turn the
intent on.

When you mention the bot yourself, pick it from the `@` autocomplete under
**MEMBERS**. Discord creates an identically named role beside every bot, and
that entry produces a role ping, which does not address it.

## No commands

Discord has no text-command convention, so nothing arrives as a `Command`:
there is no `/start` here, and a conversation begins on the first DM or
mention. Slash commands need REST registration and an interaction response
within three seconds, and are a follow-up.

## Threads

A Discord thread is a channel of its own, so a thread's `ConversationRef` is
just its channel id and `thread` stays unset. Per-conversation state keyed on
`conversationKey` therefore separates a thread from its parent for free.

## Streaming

Discord has no streaming API, so `stream` posts on the first words and edits
the message as the answer grows: about every 1.2 seconds, under the observed
five-edits-per-five-seconds-per-channel bucket, only when there is something
new to show, with a final edit for the tail and a fresh message once the
answer passes 2000 characters. `stream` in the config tunes the pace.

## Media

`Messenger.media(source, { caption, filename })` uploads bytes and base64 as
a real attachment. Discord cannot attach a URL, so a `url` source is sent as
the message text for Discord to unfurl, rather than as an embed, which would
need the **Embed Links** permission. Editing a media message is
`MessengerUnsupported`: send a new one.

## Reactions

`react` takes a unicode emoji, or `name:id` for a custom one, which is the
same spelling a `Reaction` event delivers. An emoji Discord does not know
comes back as `MessengerUnsupported`.

## Typing

`typing` keeps the indicator on until the scope you acquired it in closes.
Discord's lasts ten seconds, so the provider re-sends it every eight.

## Buttons

A button press arrives as an `Action` with the component's `custom_id` as
`actionId` and a select's values comma-joined into `value`. The provider
answers Discord's three-second interaction deadline for you, with a deferred
update that changes nothing on screen, so your handler is never racing a
clock. Posting the buttons themselves is `Messenger.raw` for now; ephemeral
replies have no verb yet.

## Anything else

`Messenger.raw({ method, path, body })` calls any v10 endpoint as-is against
the API base. For `post`, the response must carry an `id` so one comes back.

## Reconnects

The provider heartbeats, resumes and reconnects on its own, with a capped
exponential backoff, and a session that goes quiet without acknowledging a
heartbeat is closed and resumed. None of that reaches `events`. Only a close
Discord says not to retry (a rejected token, an invalid or disallowed intent,
a bad API version, a sharding demand) ends the stream, as
`MessengerTransportClosed` naming the code.

## Errors

- `MessengerConnectFailed`: the token was refused, or the gateway rejected the
  handshake, at wiring time.
- `MessengerTransportClosed`: a gateway close reconnecting cannot fix.
- `MessengerRateLimited`: a 429; `retryAfter` is Discord's own `retry_after`.
- `MessengerRequestFailed`: anything else Discord rejected, with its message
  and error code.
- `MessengerUnsupported`: an emoji Discord does not know, editing media.
