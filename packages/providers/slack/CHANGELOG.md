# @effect-uai/slack

## 0.17.0

## 0.16.0

## 0.15.0

### Minor Changes

- 3a97956: Add `@effect-uai/slack`, the third `Messenger` provider.

  `layer({ botToken, appToken, replyIn?, stream?, baseUrl? })` registers `Slack` and `Messenger` over one Socket Mode websocket and the Web API, on plain `HttpClient` and `Socket`. No `@slack/bolt`, no `@slack/web-api`.

  - Building the layer runs `auth.test`, opens a connection and waits for `hello`, so a rejected bot or app token is a `MessengerConnectFailed` at wiring time rather than a stream that dies a moment later.
  - The adapter holds no conversation state, only transport state: every event is computed from the payload in hand. Envelopes are acknowledged inside Slack's three second deadline before they reach `events`, a redelivery is dropped on `event_id`, a scheduled refresh reopens without backing off, and any other drop reconnects on a capped exponential schedule. Only a `link_disabled` disconnect ends `events`, as `MessengerTransportClosed`.
  - `addressed` is a DM or a mention. A thread follow-up without one is not: Slack's payload does not say who opened the thread. A channel mention arrives twice, as `app_mention` and `message.channels`, and only the first reaches `events`; anything with a `bot_id`, and every edit or deletion subtype, is dropped.
  - `replyIn: "thread"` (the default) mints a conversation thread from a top-level mention's own timestamp, so the bot answers under it and follow-ups inside map back; `"channel"` answers in the channel. A DM never gets a synthetic thread.
  - `post` and `edit` send `markdown_text` verbatim, split at 4000 characters, with `thread_ts` from the conversation, and `stream` is `streamViaEdits` at 1.2 s. Media takes the three-step external upload with the caption as `initial_comment`; a URL goes as the link for Slack to unfurl.
  - Slash commands map one to one onto `Command`, block actions onto one `Action` per pressed element. `react` takes a shortcode with or without colons, and `typing` is `agents.sessions.setStatus`, swallowed where Slack does not render it.

  **Recipe** (`recipes/messenger-agent`): `--messenger slack` reads `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` and prompts the persona for markdown.
