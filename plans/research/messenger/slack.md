# Subagent report: Slack agent bot without Bolt (2026-09-06)

Raw research report. Summarised in [../../messenger.md](../../messenger.md).

## 1. Auth and scopes

- **App-level token** `xapp-...` with `connections:write`: only for
  `apps.connections.open`. Sent as `Authorization: Bearer xapp-...` header.
  https://docs.slack.dev/apis/events-api/using-socket-mode
- **Bot token** `xoxb-...` for every Web API call. Scopes: `app_mentions:read`,
  `channels:history`, `groups:history`, `im:history`, `mpim:history`,
  `chat:write`, `reactions:read`, `reactions:write`, `files:write` (uploads),
  `assistant:write` (auto-added when the Agents feature is toggled; setStatus
  now only needs `chat:write`). Threads and ephemeral need nothing beyond
  `chat:write`. `chat:write.customize` only to override username/icon.
- **Events**: `app_mention`, `message.channels`, `message.groups`,
  `message.im`, `message.mpim`, `reaction_added`, `app_home_opened`.
  `assistant_thread_started`/`assistant_thread_context_changed` are legacy;
  for the new Agents surface subscribe to `app_context_changed`,
  `agent_session_stopped`, `agent_session_title_changed` instead.
  https://docs.slack.dev/ai/developing-ai-apps
- Bot user id for self-detection: `auth.test` returns `user_id` and `bot_id`.

## 2. Socket Mode

- `POST https://slack.com/api/apps.connections.open` (Tier 3) returns
  `{ok, url: "wss://wss-....slack.com/link/?ticket=...&app_id=..."}`; the URL is
  single-use/short-lived. Append `&debug_reconnects=true` to shorten
  connection lifetime from ~3600s to 360s for testing.
- First frame:
  `{"type":"hello","num_connections":N,"debug_info":{"approximate_connection_time":3600,...},"connection_info":{"app_id"}}`.
- Envelope:
  `{"envelope_id","type":"events_api"|"interactive"|"slash_commands","payload":{...},"accepts_response_payload":bool,"retry_attempt"?,"retry_reason"?}`.
  For `events_api` the payload is the standard Events API wrapper (`team_id`,
  `api_app_id`, `event`, `authorizations`, `event_id`, `event_time`).
  https://docs.slack.dev/apis/events-api/
- **Ack**: send `{"envelope_id": "..."}` (optionally `payload`) **within 3
  seconds**, or Slack treats delivery as failed and retries (three attempts:
  immediate, +1 min, +5 min), flagged via `retry_attempt`/`retry_reason` in
  the envelope. Dedupe on `event_id`.
- `{"type":"disconnect","reason":"warning"|"refresh_requested"|"link_disabled"}`:
  `warning` arrives ~10s before a rolling refresh; on `refresh_requested`
  open a new connection (call `apps.connections.open` again) before closing
  the old one. Connections cycle every few hours.
- Up to **10 concurrent connections** per app; envelopes are distributed
  unpredictably across them (use for zero-downtime restart). Standard WS
  ping/pong frames keep-alive; the official SDKs send pings every ~10s.
- **Policy**: Socket Mode apps cannot be listed in the Slack Marketplace and
  require granular (bot) permissions; Slack positions it for internal apps or
  apps behind firewalls. Fine for a custom workspace bot.

## 3. Inbound event shapes

- `app_mention`:
  `{type, user, text:"<@U0LAN0Z89> hi", ts, channel, thread_ts?, event_ts, team, blocks}`.
  Channels only; DMs arrive as `message.im`.
  https://docs.slack.dev/reference/events/app_mention
- `message`:
  `{type:"message", channel, user, text, ts, thread_ts?, channel_type:"channel"|"group"|"im"|"mpim", subtype?, bot_id?}`.
  Subtypes to filter: `bot_message`, `message_changed`, `message_deleted`,
  `thread_broadcast`, `file_share`. Own-message detection: `bot_id` present,
  or `user === auth.test().user_id`. An `app_mention` in a channel also
  arrives as `message.channels` if you subscribe to both; dedupe by
  `(channel, ts)`. https://docs.slack.dev/reference/events/message
- `reaction_added`:
  `{user, reaction:"eyes", item_user, item:{type:"message", channel, ts}, event_ts}`.
- `interactive` envelope payload `block_actions`:
  `{type, trigger_id, response_url, user, channel, container:{message_ts, channel_id, thread_ts?}, message, actions:[{action_id, block_id, value, type, action_ts}], state.values}`.
  Ack in 3s; reply via `response_url` (`replace_original`,
  `response_type:"ephemeral"`).
  https://docs.slack.dev/reference/interaction-payloads/block_actions-payload

## 4. Outbound Web API (plain JSON over HTTPS)

`POST https://slack.com/api/<method>` with
`Content-Type: application/json; charset=utf-8` and
`Authorization: Bearer xoxb-...`. Response
`{ok, error?, response_metadata?{next_cursor, warnings, messages}}`.

- `chat.postMessage` (channel, text | blocks | markdown_text, thread_ts,
  reply_broadcast, mrkdwn, metadata, unfurl_*). Truncates at 40,000 chars;
  keep `text` under 4,000; `markdown_text` (12,000 max, standard Markdown,
  exclusive with text/blocks). Returns `{channel, ts, message}`.
  https://docs.slack.dev/reference/methods/chat.postMessage
- `chat.update` (channel, ts, text|blocks|markdown_text), Tier 3, own
  messages only; ephemeral cannot be updated.
- `chat.postEphemeral` (channel, user, text|blocks, thread_ts), `chat.delete`
  (channel, ts), `reactions.add` (channel, timestamp, name:"eyes"),
  `reactions.remove`, `conversations.replies` (channel, ts, cursor, limit).
- Files: `files.getUploadURLExternal` (filename, length) -> POST raw bytes to
  `upload_url` -> `files.completeUploadExternal` (files:[{id,title}],
  channel_id, thread_ts, initial_comment).
- Status: `agents.sessions.setStatus` (channel_id, thread_ts, status:
  `processing`|`active`|`suspended`|`closed`), Tier 3, works in DMs, channel
  threads, and public channels. Legacy `assistant.threads.setStatus` (status
  text, `loading_messages[]`, 2-minute timeout, DMs/assistant threads only)
  still works via a compatibility bridge; `assistant.threads.setTitle` ->
  `agents.sessions.rename`; `assistant.threads.setSuggestedPrompts` remains.
  https://docs.slack.dev/reference/methods/agents.sessions.setStatus

## 5. Streaming (Oct 2025+)

- `chat.startStream` (Tier 2): `channel`, `thread_ts` (omit/"0" for
  top-level), `recipient_user_id` + `recipient_team_id` (**required when
  streaming into channels**; take `user` and `team_id` from the triggering
  event), `markdown_text` XOR `chunks[]` (chunk types `markdown_text`,
  `task_update`, `plan_update`, `blocks`), `task_display_mode:
"timeline"|"plan"`. Returns `{channel, ts}`.
- `chat.appendStream` (**Tier 4**, 100+/min): `channel`, `ts`,
  `markdown_text` XOR `chunks`. Errors: `streaming_mode_mismatch`,
  `stopped_by_user` (native stop button), `message_not_owned_by_app`.
- `chat.stopStream` (Tier 2): finalizes; the only call that accepts `blocks`
  (up to 50, e.g. `context_actions` with `feedback_buttons`), plus
  `metadata`, `session_status`.
- Works in DMs, channel threads, and top-level channel messages. No Agents
  toggle documented as required; `chat:write` suffices. Replaces
  `chat.update` polling for AI output: appendStream's Tier 4 limit is the
  practical throttle (batch tokens to ~1 call/s or slower).
  https://docs.slack.dev/reference/methods/chat.startStream
  https://docs.slack.dev/changelog/2025/10/7/chat-streaming/

## 6. Rate limits

Tiers: T1 1+/min, T2 20+/min, T3 50+/min, T4 100+/min, per app per
workspace, with bursts. `chat.postMessage`: ~1 msg/s per channel with burst.
On excess: HTTP 429 + `Retry-After` seconds. Events: 30,000/hour/workspace/app,
then `app_rate_limited`. The May 29, 2025 change (`conversations.history`/
`replies` at 1 req/min, 15 objects) applies **only to commercially
distributed non-Marketplace apps**; internal/custom workspace apps and
Marketplace apps are exempt. A Socket Mode agent doing events + postMessage +
update is unaffected. https://docs.slack.dev/apis/web-api/rate-limits

## 7. Threads, ids, mentions

Reply by passing the parent `ts` as `thread_ts`; a reply has
`thread_ts !== ts`; a parent has `thread_ts === ts` (or none). To reply in the
same thread from an event use `event.thread_ts ?? event.ts`.
`reply_broadcast: true` also shows it in the channel. Ids: `C...` public,
`G...` private (older), `D...` DM; `channel_type` in message events is
authoritative. Render mentions as `<@U123>`; strip `<@BOT_ID>` from inbound
text.

## 8. Endpoint and manifest

No public HTTPS endpoint with Socket Mode. Manifest supports
`settings.socket_mode_enabled: true`, `settings.event_subscriptions.bot_events`,
`oauth_config.scopes.bot`, `features.bot_user`, and `features.agent_view` /
legacy `features.assistant_view`.
https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests

## 9. Feasibility

`@slack/bolt`, `@slack/socket-mode`, `@slack/web-api` are official but
optional. A complete agent needs one WebSocket client plus roughly 8 to 12
JSON POSTs: `apps.connections.open`, `auth.test`, `chat.postMessage`,
`chat.update`, `chat.startStream/appendStream/stopStream`, `reactions.add`,
`agents.sessions.setStatus`, optionally `chat.postEphemeral`,
`conversations.replies`, the two file-upload methods. Trivial to implement
with Effect `Socket.makeWebSocket` + `HttpClient`.

## 10. 2025/2026 changes affecting architecture

- Oct 2025: streaming methods, `markdown_text`, AI Block Kit elements.
- Jul 2026: `app_context_changed` gives agents the user's current view
  context.
- Aug 2026: `assistant_view` deprecated Feb 2027; `agents.sessions.*` and
  `agent_view` replace `assistant.threads.*`; `agent_session_stopped` event;
  compatibility bridge in the meantime.
- Recommended architecture: Socket Mode -> filter `app_mention`/`message.im`
  -> `reactions.add(eyes)` + `agents.sessions.setStatus(processing)` ->
  `chat.startStream` in `thread_ts ?? ts` -> throttled `appendStream` ->
  `stopStream` with feedback blocks; fall back to `postMessage` +
  `chat.update` if streaming errors.
