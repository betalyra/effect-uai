---
title: Slack
description: "Run your agent as a Slack bot: mentions, DMs and slash commands in, streamed markdown replies in a thread, files and reactions out. Socket Mode, no public URL, and no Bolt."
source: packages/providers/slack
---

Two tokens and a manifest are all Slack asks for. This provider registers the
`Messenger` capability over Socket Mode and the Web API on Effect's
`HttpClient` and `Socket`: it holds one websocket, so it runs anywhere with
outbound internet and needs no request URL, and it needs no `@slack/bolt`.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/slack effect
```

## Set the app up

At [api.slack.com/apps](https://api.slack.com/apps), **Create New App → From a
manifest**, and paste this. It turns on Socket Mode, asks for the scopes the
five verbs need, and subscribes to the events that become an `InboundEvent`.

```yaml
display_information:
  name: Betty
features:
  bot_user:
    display_name: Betty
    always_online: true
  slash_commands:
    - command: /start
      description: Say hello
      should_escape: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - chat:write
      - commands
      - reactions:read
      - reactions:write
      - files:write
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - reaction_added
```

Then collect the two tokens the provider wants:

- **Basic Information → App-Level Tokens → Generate**, scope
  `connections:write`. The `xapp-` token opens the socket, and is used for
  nothing else.
- **OAuth & Permissions → Install to Workspace**. The `xoxb-` bot token makes
  every other call.

Invite the bot where you want it with `/invite @Betty`.

## Wire it up

```ts
import { Effect, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { layer as slackLayer } from "@effect-uai/slack/Slack"

const provider = slackLayer({
  botToken: Redacted.make(process.env.SLACK_BOT_TOKEN!),
  appToken: Redacted.make(process.env.SLACK_APP_TOKEN!),
})

await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(provider), Effect.provide(NodeHttpClient.layerUndici)),
)
```

Building the layer authenticates and waits for Slack's `hello` frame, so a
rejected token fails right here as `MessengerConnectFailed`. From then on the
connection is live until the scope closes.

The layer registers `Messenger` and, for code that wants the bot's own
`userId`, `botId` and `teamId`, the typed `Slack` tag.

| Option     | Default         | What it does                             |
| ---------- | --------------- | ---------------------------------------- |
| `botToken` | required        | `xoxb-` token, `Redacted`.               |
| `appToken` | required        | `xapp-` token, `Redacted`.               |
| `replyIn`  | `"thread"`      | Where a top-level mention is answered.   |
| `stream`   | `every: 1.2s`   | `every`, `minChars`, `rateLimitRetries`. |
| `baseUrl`  | `slack.com/api` | For a proxy in front of the Web API.     |

## Tell the model to write markdown

Text goes out as `markdown_text`, verbatim, so one line in your system prompt
is all the formatting setup there is.

> Format replies as markdown: `**bold**`, `*italic*`, `` `code` ``, fenced
> code blocks and bare links. No HTML.

## Getting mentioned

`addressed` is true for a DM and for an `@mention` of the bot. The bot's own
mention is stripped from `text` before you see it, and anything written by a
bot, this one included, is dropped before it reaches the stream.

A thread follow-up without a mention arrives `addressed: false`. Slack's
payload does not say who opened the thread, and this adapter keeps no memory
of conversations, so **in a thread, mention the bot**, as you would in a
channel.

Slack sends a channel mention twice, as `app_mention` and again as
`message.channels`. Only one reaches `events`.

## Threads

`replyIn` decides what a top-level mention starts:

- **`"thread"`** (the default) gives the conversation a `thread` minted from
  the mention's own timestamp, so the bot answers in a thread under it and a
  follow-up inside that thread is the same conversation. A later top-level
  mention starts a new one.
- **`"channel"`** leaves `thread` unset and the bot answers in the channel.

A DM never gets a synthetic thread. Outbound, every verb sends `thread_ts`
whenever the conversation names one, and `replyTo` outside a thread opens one
on that message, which is what a reply is on Slack.

## Commands

A slash command in the manifest arrives as a `Command` with the slash dropped
from `name` and the rest of the line as `args`, which is the one platform
where the shared shape maps one to one. A command names no thread, so it
starts at channel level.

## Streaming

`stream` posts on the first words and edits the message as the answer grows:
about every 1.2 seconds, only when there is something new to show, with a
final edit for the tail and a fresh message once the answer passes 4000
characters. `stream` in the config tunes the pace. Slack's native
`chat.startStream` needs a recipient the ambient conversation does not name,
and is a follow-up.

## Media

`Messenger.media(source, { caption, filename })` uploads bytes and base64 as a
real file, with the caption as its comment. A `url` source goes as the link
for Slack to unfurl. The id you get back is the message the file was shared
as when Slack reports one, otherwise the file id. Editing a media message is
`MessengerUnsupported`: send a new one.

## Reactions

`react` takes a shortcode, with or without colons, which is the same spelling
a `Reaction` event delivers. One the workspace does not have comes back as
`MessengerUnsupported`.

A `reaction_added` event names the message but not the thread it sits in, so
under `replyIn: "thread"` a reaction reaches a conversation only when it is on
the message that opened the thread.

## Typing

`typing` sets the session status for as long as the scope is open. Slack
renders it on its agent surfaces, so elsewhere nothing shows; a rejection is
logged at debug level and swallowed, and `typing` never fails a turn.

## Buttons

A button press arrives as an `Action` with the element's `action_id` as
`actionId` and its `value`, one per element pressed, in the container's thread.
Posting the buttons themselves is `Messenger.raw` for now; ephemeral replies
have no verb yet.

## Anything else

`Messenger.raw({ method, params })` calls any Web API method as-is. For
`post`, the response must carry a `ts` so an id comes back.

## Reconnects

Slack cycles a Socket Mode connection every few hours. The provider opens a
fresh one when Slack asks, and reconnects on a capped exponential backoff when
one drops. Every envelope is acknowledged before it reaches you, inside the
three second deadline, and a redelivery Slack sends anyway is dropped. None of
that reaches `events`. Only a `link_disabled` disconnect ends the stream, as
`MessengerTransportClosed`.

Run **one instance per app**: a second one gets its own connection and Slack
spreads envelopes across both unpredictably.

## Errors

- `MessengerConnectFailed`: a token was refused, at wiring time.
- `MessengerTransportClosed`: Slack disabled the connection.
- `MessengerRateLimited`: a 429; `retryAfter` is Slack's `Retry-After`.
- `MessengerRequestFailed`: anything else Slack rejected, with its `error`
  string as the reason.
- `MessengerUnsupported`: an emoji the workspace does not have, editing media.
