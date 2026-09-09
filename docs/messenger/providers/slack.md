---
title: Slack
description: "Run your agent as a Slack bot: mentions, DMs and slash commands in, streamed markdown replies in a thread, files and reactions out. Socket Mode, no public URL, and no Bolt."
source: packages/providers/slack
---

To run your agent as a Slack bot you need a Slack app with Socket Mode, its
two tokens, and this package. It holds one websocket to Slack, so it works
from a laptop or a container with no request URL, and it uses no Bolt.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/slack effect
```

## Create the app

At [api.slack.com/apps](https://api.slack.com/apps), **Create New App → From
a manifest**, and paste this. It turns on Socket Mode, asks for the scopes
the verbs need, and subscribes to the events that reach you.

```yaml
display_information:
  name: My Agent
features:
  bot_user:
    display_name: My Agent
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

Then the two tokens:

- **Basic Information → App-Level Tokens → Generate**, scope
  `connections:write`. This `xapp-` token opens the socket and nothing else.
- **OAuth & Permissions → Install to Workspace**. This `xoxb-` bot token
  makes every other call.

Invite the bot to a channel with `/invite @My Agent`.

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

Building the layer authenticates and waits for Slack's `hello`, so a
rejected token fails here, as `MessengerConnectFailed`. From then on the
connection is live until the scope closes. Run one instance per app: a
second one gets its own connection and Slack spreads events across both.

The layer registers `Messenger`, plus the typed `Slack` tag for code that
wants the bot's own `userId`, `botId` and `teamId`.

| Option     | Default         | What it does                             |
| ---------- | --------------- | ---------------------------------------- |
| `botToken` | required        | `xoxb-` token, `Redacted`.               |
| `appToken` | required        | `xapp-` token, `Redacted`.               |
| `replyIn`  | `"thread"`      | Where a top-level mention is answered.   |
| `stream`   | `every: 1.2s`   | `every`, `minChars`, `rateLimitRetries`. |
| `baseUrl`  | `slack.com/api` | For a proxy in front of the Web API.     |

## Tell the model to write markdown

Text goes out as Slack's `markdown_text`, verbatim, so one line in your
system prompt is all the formatting setup there is:

> Format replies as markdown: `**bold**`, `*italic*`, `` `code` ``, fenced
> code blocks and bare links. No HTML.

## Getting mentioned

`addressed` is true for a DM and for an `@mention` of the bot. The bot's own
mention is stripped from `text`, and anything written by a bot is dropped
before it reaches you.

In a thread, mention the bot again: Slack does not say who a thread belongs
to, so a follow-up without a mention arrives `addressed: false`. Slack sends
a channel mention twice, as `app_mention` and as a channel message; only one
reaches `events`.

## Threads

`replyIn` decides what a top-level mention starts:

- `"thread"` (the default) gives the conversation a `thread` from the
  mention's own timestamp. The bot answers in a thread under it, and a
  follow-up inside that thread is the same conversation. A later top-level
  mention starts a new one.
- `"channel"` leaves `thread` unset and the bot answers in the channel.

A DM never gets a thread of its own. Every verb sends `thread_ts` whenever
the conversation names one, and a `replyTo` outside a thread opens one on
that message, which is what a reply is on Slack.

## Commands

A slash command from the manifest arrives as a `Command` with the slash
dropped from `name` and the rest of the line as `args`. A command names no
thread, so it starts at channel level.

## Streaming

`stream` posts on the first words and edits the message as the answer grows:
about every 1.2 seconds, only when there is something new to show, with a
final edit for the tail and a fresh message once the answer passes 4000
characters. `stream` in the config tunes the pace. Slack's own streaming API
is not used yet.

## Media

`Messenger.media(source, { caption, filename })` uploads bytes and base64 as
a file, with the caption as its comment. A `url` source goes as a link for
Slack to unfurl. The id you get back is the message the file was shared as,
or the file id when Slack reports no message. Editing a media message is
`MessengerUnsupported`: send a new one.

## Reactions

`react` takes a shortcode such as `eyes`, with or without colons, which is
how a `Reaction` event arrives too. One the workspace does not have comes
back as `MessengerUnsupported`.

A reaction inside a thread arrives with the reacted message's own timestamp
as its `thread`, not the thread it sits in. Under `replyIn: "thread"` that
means only a reaction on the message that opened the thread lands in that
conversation.

## Typing

`typing` sets the session status for as long as the scope is open. Slack
shows it on its agent surfaces; elsewhere nothing shows and nothing fails.

## Buttons

A button press arrives as an `Action` with the element's `action_id` as
`actionId` and its `value`, one per element pressed, in the thread of the
message it sat on. Sending the buttons themselves is `Messenger.raw`.

## Anything else

`Messenger.raw({ method, params })` calls any Web API method as-is. For
`post`, the response must carry a `ts` so an id comes back.

## Reconnects

Slack cycles a Socket Mode connection every few hours. The provider opens a
fresh one when Slack asks and reconnects with a capped backoff when one
drops. Every event is acknowledged inside Slack's three-second deadline
before it reaches you, and a redelivery is dropped. None of that reaches
`events`. Only a `link_disabled` disconnect ends the stream, as
`MessengerTransportClosed`.

## Errors

- `MessengerConnectFailed`: a token was refused, at wiring time.
- `MessengerTransportClosed`: Slack disabled the connection.
- `MessengerRateLimited`: a 429; `retryAfter` is Slack's `Retry-After`.
- `MessengerRequestFailed`: anything else Slack rejected, with its `error`
  string as the reason.
- `MessengerUnsupported`: an emoji the workspace does not have, editing media.
