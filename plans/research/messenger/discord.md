# Subagent report: Discord bot without discord.js (2026-09-06)

Raw research report. Summarised in [../../messenger.md](../../messenger.md).

Docs moved to `https://docs.discord.com/developers/...` (Feb 2026 Mintlify
migration); `discord.com/developers/docs/*` 301-redirects there.

## 1. Auth and base

- Base: `https://discord.com/api/v10`. v10 and v9 "Available"; v6 is still the
  unversioned default (deprecated), so always pin `/v10`. No v11 exists.
  https://docs.discord.com/developers/reference
- Header: `Authorization: Bot <token>`. Required
  `User-Agent: DiscordBot ($url, $versionNumber)`.
- `GET /gateway/bot` returns
  `{ url, shards, session_start_limit: { total, remaining, reset_after, max_concurrency } }`.
  Sharding only mandatory at 2500 guilds. Identify budget: 1000 IDENTIFYs / 24h.
  https://docs.discord.com/developers/events/gateway

## 2. Gateway protocol

- Connect: `wss://gateway.discord.gg/?v=10&encoding=json`.
  `compress=zlib-stream|zstd-stream` is optional; compression is NOT required.
- Payload: `{ op, d, s, t }` (`s`,`t` null unless op 0).
- Opcodes: 0 Dispatch (recv), 1 Heartbeat (send, `d` = last `s` or null),
  2 Identify, 3 Presence Update, 6 Resume, 7 Reconnect (recv), 9 Invalid
  Session (recv), 10 Hello (recv, `d.heartbeat_interval` ms), 11 Heartbeat ACK
  (recv). https://docs.discord.com/developers/topics/opcodes-and-status-codes
- Heartbeat: first one after `heartbeat_interval * random(0..1)` (jitter), then
  every interval. Zombie rule: no ACK (op 11) between two heartbeats means
  close with a non-1000/1001 code and reconnect+resume. Server may also send
  op 1 to request an immediate heartbeat.
- Identify (op 2):
  `{ token, intents, properties: { os, browser, device }, compress?, large_threshold?, shard?, presence? }`.
  Limit: 1 identify per 5s per connection; 120 sends / 60s per connection.
- Ready (t=READY): `v, user, guilds, session_id, resume_gateway_url, shard?, application`.
  Store `session_id`, `resume_gateway_url`, last `s`.
- Resume (op 6): `{ token, session_id, seq }` sent to `resume_gateway_url`;
  server replays missed dispatches then `RESUMED`.
- Invalid Session (op 9): `d: true` means resumable; `d: false` means wait
  1-5s random, open new connection, re-Identify.
- Reconnect (op 7): close and resume immediately.
- Close codes: 4000/4001/4002/4003/4005/4007/4008/4009 reconnect (resume;
  4007/4009 need a fresh session). Fatal (do not retry): 4004 auth failed,
  4010 invalid shard, 4011 sharding required, 4012 invalid API version,
  4013 invalid intents, 4014 disallowed intents (privileged intent not toggled
  in portal).

## 3. Intents (bits)

GUILDS `1<<0`, GUILD_MESSAGES `1<<9`, GUILD_MESSAGE_REACTIONS `1<<10`,
DIRECT_MESSAGES `1<<12`, DIRECT_MESSAGE_REACTIONS `1<<13`, MESSAGE_CONTENT
`1<<15` (privileged). Mention-bot use case:
`1 | 512 | 1024 | 4096 | 8192 | 32768 = 46593`.

- Without MESSAGE_CONTENT, `content`, `embeds`, `attachments`, `components`,
  `poll` arrive empty EXCEPT: bot's own messages, DMs with the bot, messages
  that @mention the bot, message context-menu targets. So a pure
  "@mention or DM" agent bot works without the privileged intent.
- Enable in Developer Portal > Bot > Privileged Gateway Intents. New rule
  since Jun 10, 2026: threshold is 10,000 users (was 100 servers); above that,
  apply for review; approved apps reapply annually.
  https://docs.discord.com/developers/change-log

## 4. Inbound events

- MESSAGE_CREATE: message object plus `guild_id?`, `member?`, `mentions`
  (user objects with partial `member`), `channel_type?`. Message fields:
  `id, channel_id, author{id,username,bot}, content, mentions, mention_everyone, referenced_message?, message_reference?, thread?, type, flags, components, webhook_id?, interaction_metadata?`.
  https://docs.discord.com/developers/resources/message
- Detect "mentioned bot": `mentions.some(u => u.id === readyUser.id)`
  (mentions is populated regardless of intent). DM: `guild_id` absent or
  `channel_type === 1`. Skip `author.bot === true` to avoid loops.
  Reply-to-bot: `referenced_message?.author.id === botId`. Thread:
  `channel_type` 11/12; if the bot's message spawned the thread,
  `message.thread` is set on the parent.
- MESSAGE_REACTION_ADD:
  `user_id, channel_id, message_id, guild_id?, member?, emoji{id,name}, message_author_id?, burst`.
- THREAD_CREATE: channel object with `newly_created: true`.
- INTERACTION_CREATE:
  `{ id, application_id, type (1 PING, 2 APPLICATION_COMMAND, 3 MESSAGE_COMPONENT, 4 AUTOCOMPLETE, 5 MODAL_SUBMIT), data, guild_id?, channel_id, member|user, token, message?, app_permissions, context }`.
  Command data: `id, name, type, options[], resolved`. Component data:
  `custom_id, component_type, values[]`. Respond within 3s:
  `POST /interactions/{id}/{token}/callback` with
  `{ type: 4, data: {content, flags?} }` or `{ type: 5 }` (deferred),
  6 deferred update, 7 update message, 9 modal. Token valid 15 min;
  follow-ups via `POST /webhooks/{app_id}/{token}`, edit original via
  `PATCH /webhooks/{app_id}/{token}/messages/@original`.
  https://docs.discord.com/developers/interactions/receiving-and-responding

## 5. Outbound REST

- `POST /channels/{id}/messages`: `content` (max 2000), `embeds` (max 10,
  6000 chars total), `components`,
  `allowed_mentions {parse[], users[], roles[], replied_user}`,
  `message_reference {message_id, fail_if_not_exists?, type: 0 reply | 1 forward}`,
  `flags`, `files` (multipart). Use `allowed_mentions: { parse: [] }` to
  prevent accidental pings.
- `PATCH /channels/{id}/messages/{mid}`: editable
  `content, embeds, flags, allowed_mentions, components, attachments`; only
  the author can edit content.
- `PUT /channels/{id}/messages/{mid}/reactions/{emoji}/@me`: unicode emoji
  URL-encoded (`%F0%9F%91%80`), custom as `name:id`. 204 on success.
- `POST /channels/{id}/typing`: 204, expires after 10s; re-fire every ~8s.
- Threads: `POST /channels/{id}/messages/{mid}/threads {name (1-100), auto_archive_duration?: 60|1440|4320|10080}`;
  `POST /channels/{id}/threads {name, type: 11|12}`; post inside with
  `POST /channels/{thread_id}/messages`.
- Ephemeral: only via interaction responses/follow-ups with `flags: 64`.
- DMs: `POST /users/@me/channels {recipient_id}` returns DM channel; then post
  to it.

## 6. Rate limits

- Headers:
  `X-RateLimit-Limit/Remaining/Reset/Reset-After (float seconds)/Bucket/Global/Scope (user|global|shared)`.
  429 body `{ message, retry_after (float seconds), global, code? }` plus
  `Retry-After`. Global: 50 req/s. Buckets keyed by `X-RateLimit-Bucket` +
  major param (`channel_id`, `guild_id`, `webhook_id`). 10,000 invalid
  (401/403/429) responses per 10 min triggers a Cloudflare ban (~1h).
  https://docs.discord.com/developers/topics/rate-limits
- Community-observed (undocumented, learn from headers): POST message 5/5s per
  channel; PATCH message widely reported as 5/5s per channel too; reactions
  1 per 0.25s; delete 5/1s.
- Streaming/edit-in-place guidance: throttle edits to ~1-1.5s (a common
  figure is 1.2s), coalesce chunks, always flush a final edit; when the
  buffer exceeds ~1900 chars, finalize and start a new message (2000 hard
  limit). Track buckets client-side from headers rather than hard-coding.

## 7. Slash commands

`PUT /applications/{app_id}/commands` (global bulk overwrite; docs still
state ~1h propagation) vs `PUT /applications/{app_id}/guilds/{gid}/commands`
(instant). Limits: 100 CHAT_INPUT, 15 USER, 15 MESSAGE, 200 creates/day/guild.
Needs `applications.commands` scope. Not required at all for a mention/DM
text bot.

## 8. Public endpoint

Not required. Gateway delivers `INTERACTION_CREATE` when no Interactions
Endpoint URL is configured; the two are mutually exclusive. HTTP mode needs
Ed25519 verification (`X-Signature-Ed25519`, `X-Signature-Timestamp`) and
PING/PONG.

## 9. SDK and feasibility

No official TS SDK; `discord-api-types` is types-only (v10 namespace). A
plain-WS client needs: connect, Hello, jittered heartbeat with ACK watchdog,
Identify, sequence tracking, Resume/Invalid Session/Reconnect handling,
close-code classification, and a bucketed REST client. Roughly 200-300 lines
for the gateway state machine, ~100 for REST with header-driven bucket
tracking. Fits cleanly on Effect `Socket.makeWebSocket` (remember
`closeCodeIsError` override) plus `Queue.end` on the reader fiber.

## 10. 2025/2026 changes worth knowing

- Components V2 (flag `IS_COMPONENTS_V2 = 1<<15 = 32768`): Text Display (10),
  Section (9), Container (17), Media Gallery (12), etc.; disables
  `content`/`embeds`, max 40 components, 4000 chars text; flag is irreversible
  once set. Legacy content+embeds still works.
  https://docs.discord.com/developers/components/reference
- User-installable apps: `integration_types` (0 GUILD_INSTALL, 1 USER_INSTALL)
  and `contexts` (0 GUILD, 1 BOT_DM, 2 PRIVATE_CHANNEL) on commands.
- Privileged intents: 10k-user threshold + annual reapplication (Jun 2026).
  Forwarding messages now requires message content access (Apr 2026).
  Channel obfuscation for channels without VIEW_CHANNEL (Aug 2026).
- Gateway v10 remains current; no v11.
