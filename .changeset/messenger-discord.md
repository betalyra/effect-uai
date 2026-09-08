---
"@effect-uai/core": patch
"@effect-uai/discord": minor
---

Add `@effect-uai/discord`, the second `Messenger` provider.

`layer({ token, intents?, stream?, baseUrl? })` registers `Discord` and `Messenger` over one gateway websocket and the v10 REST API, on plain `HttpClient` and `Socket`. No discord.js, no `discord-api-types`.

- Building the layer identifies and waits for `READY`, so a rejected token or an intent the portal has not granted is a `MessengerConnectFailed` at wiring time rather than a stream that dies a moment later.
- The session heartbeats with a jittered first beat, tracks the sequence, closes and resumes a connection that stops acknowledging, and reconnects on a capped exponential backoff. Only a close Discord says not to retry (4004, 4010 to 4014) ends `events`, as `MessengerTransportClosed`.
- `addressed` is a DM, a mention of the bot, or a reply to one of its messages; `@everyone` and role pings do not count, the bot's own mention is stripped from `text`, and messages written by any bot are dropped.
- A thread is a channel, so a thread's `ConversationRef` is its own channel id with `thread` unset.
- `post` and `edit` send markdown verbatim with `allowed_mentions: { parse: [] }`, split at 2000 characters, and `stream` is `streamViaEdits` at 1.2 s, under the observed edit bucket. Media uploads bytes and base64 as attachments; a URL goes as content for Discord to unfurl, since an embed needs the Embed Links permission and is stripped without it.
- Component presses arrive as `Action` and are acknowledged inside the adapter, ahead of Discord's three-second interaction deadline. A 429 is `MessengerRateLimited` carrying Discord's `retry_after`.
- No `Command` events: Discord has no text-command convention, and slash commands are a follow-up.

**Core**: `streamViaEdits` no longer posts a message that is only whitespace. A model opening a tool-calling turn with a newline used to produce one, which Telegram and Discord both reject as an empty message and which took the turn down with it. Both gates now measure trimmed text, so a stream that never held real text posts nothing and yields `None`.

**Recipe** (`recipes/messenger-agent`):

- `--messenger telegram | discord` picks the layer and the markup its persona writes; `--read-all` asks Discord for the privileged Message Content intent, without which only DMs and mentions carry text.
- A `react` tool, built per conversation over that conversation's last message id, so the agent can react to what it was just told. `Options.status` makes the per-tool status line the platform's markup rather than hard-coded HTML.
- Reactions are turns: an emoji in a chat already talking reaches the loop as `[reacted 🤔]`, while one in a quiet channel starts nothing.
- `LOG_LEVEL=Debug` traces every inbound event, each turn's start and finish, and each tool call.
