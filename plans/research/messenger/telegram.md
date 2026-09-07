# Subagent report: Telegram Bot API (2026-09-06)

Raw research report. Summarised in [../../messenger.md](../../messenger.md).

Sources: https://core.telegram.org/bots/api (Bot API 10.3, Aug 24 2026),
https://core.telegram.org/bots/api-changelog, https://core.telegram.org/bots/faq,
https://core.telegram.org/bots/features, https://core.telegram.org/bots/webhooks.

## 1. Auth and envelope

- URL: `https://api.telegram.org/bot<token>/METHOD_NAME`. Method names are
  case-insensitive. GET or POST; params via query string,
  `application/x-www-form-urlencoded`, `application/json` (not for file
  uploads), or `multipart/form-data` (uploads).
- Response: `{ ok: boolean, result?: T, description?: string, error_code?: number, parameters?: { migrate_to_chat_id?: number, retry_after?: number } }`.
  `error_code` mirrors the HTTP status (400/401/403/409/429). Docs say
  error_code contents are "subject to change".
- 429 body: `{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 35","parameters":{"retry_after":35}}`.
- `chat.id` / `from.id` are up to 52 significant bits: safe in a JS `number`,
  but not 32-bit.

## 2. Inbound

**getUpdates** (`offset`, `limit` 1-100 default 100, `timeout` seconds
default 0, `allowed_updates` string[]):

- Ack = offset. "An update is considered confirmed as soon as getUpdates is
  called with an offset higher than its update_id"; pass
  `offset = last_update_id + 1`. Negative offset = last N from queue end.
  Unconfirmed updates kept 24h.
- `timeout`: "Should be positive, short polling should be used for testing
  purposes only." No documented max; community clients use 30-50s.
- `allowed_updates` persists across calls; empty list = all types except
  `chat_member`, `message_reaction`, `message_reaction_count` (must be
  requested explicitly; `message_reaction` also requires the bot to be a chat
  admin, and is never sent for reactions set by bots).
- "This method will not work if an outgoing webhook is set up." Single
  consumer: a second poller gets
  `409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`.
- No public endpoint needed. No documented cap on concurrent getUpdates beyond
  the one-poller rule.

**setWebhook** (`url` HTTPS, `certificate` for self-signed PEM, `ip_address`,
`max_connections` 1-100 default 40, `allowed_updates`, `drop_pending_updates`,
`secret_token` 1-256 chars `[A-Za-z0-9_-]` delivered as header
`X-Telegram-Bot-Api-Secret-Token`). Ports 443/80/88/8443 only; TLS 1.2+;
retries on non-2xx; source IPs 149.154.160.0/20, 91.108.4.0/22.
`deleteWebhook` to go back to polling.

**Update**: `update_id` plus exactly one of `message`, `edited_message`,
`channel_post`, `edited_channel_post`, `business_connection`,
`business_message`, `edited_business_message`, `deleted_business_messages`,
`guest_message`, `message_reaction`, `message_reaction_count`, `inline_query`,
`chosen_inline_result`, `callback_query`, `my_chat_member`, `chat_member`,
`chat_join_request`, `stopped_message_generation` (10.3), and others (polls,
payments, boosts, managed_bot, subscription).

**Message** fields of interest: `message_id`, `message_thread_id`,
`is_topic_message`, `from` (User: `id`, `is_bot`, `username`), `sender_chat`,
`chat` (`id`, `type`: `private|group|supergroup|channel`, `is_forum`, `title`,
`username`), `date`, `text`, `entities[]`, `caption`, `reply_to_message`,
`external_reply`, `quote`, `business_connection_id`, `forward_origin`,
`edit_date`, `receiver_user`/`ephemeral_message_id` (ephemeral).

**MessageEntity**: `type`, `offset`, `length` in UTF-16 code units; types
include `mention` (`@username`), `text_mention` (has `user`, for users without
username), `bot_command`, `url`, `email`, `bold`, `code`, `pre`, `text_link`,
`custom_emoji`, `blockquote`, `date_time`.

## 3. Mentions in groups

- Privacy mode (default on): bot sees only commands addressed to it
  (`/cmd@bot`, or plain `/cmd` if it was the last bot to post), replies to its
  messages, all service messages, and all private-chat messages. Admin bots and
  privacy-off bots see everything except messages from other bots (never
  delivered, regardless of mode). Toggle via BotFather `/setprivacy`; bot must
  be re-added to groups for the change to apply.
- A bare `@bot` mention is NOT delivered under privacy mode unless it's a
  command or reply. Turn privacy off (or make the bot admin) for
  "mention to address" UX.
- Detect "addressed to bot": (a) `chat.type === "private"`; (b) an entity of
  type `mention` whose slice `text.substr(offset, length)` (UTF-16) equals
  `@<bot username>`; (c) a `bot_command` entity whose text ends with
  `@<bot username>` (or has no suffix); (d) `reply_to_message.from.id === botId`.
  Get bot identity once via `getMe` (`id`, `username`).

## 4. Outbound

- `sendMessage`: `chat_id`, `text` 1-4096 chars after entity parsing,
  `parse_mode` (`MarkdownV2` | `HTML` | legacy `Markdown`), `entities`,
  `link_preview_options` `{is_disabled, prefer_small_media, prefer_large_media, show_above_text, url}`,
  `message_thread_id`, `reply_parameters` `{message_id, chat_id?, allow_sending_without_reply?, quote?}`,
  `reply_markup` (`InlineKeyboardMarkup {inline_keyboard: Button[][]}`; button
  `{text, url?|callback_data? (1-64 bytes)|web_app?|...}`),
  `disable_notification`, `message_effect_id` (private chats),
  `business_connection_id`, `ephemeral_message_parameters`. Returns `Message`.
- MarkdownV2 escape set: `_ * [ ] ( ) ~ \` > # + - = | { } . !`(any char 1-126
escapable). HTML tags:`b/strong i/em u/ins s/strike/del span.tg-spoiler tg-spoiler code pre blockquote a tg-emoji`.
  HTML is the safer target for LLM output.
- `editMessageText`: `chat_id`+`message_id` (or `inline_message_id`), `text`,
  `parse_mode`, `entities`, `link_preview_options`, `reply_markup`. Returns
  `Message` or `True`. Identical content yields 400
  `Bad Request: message is not modified`; other 400s:
  `message to edit not found`, `message can't be edited`,
  `there is no text in the message to edit`. Business messages not sent by
  the bot: 48h window.
- `sendChatAction`: `chat_id`, `action` (`typing`, `upload_photo`,
  `record_video`, `upload_video`, `record_voice`, `upload_voice`,
  `upload_document`, `choose_sticker`, `find_location`, `record_video_note`,
  `upload_video_note`), `message_thread_id`, `business_connection_id`.
  "Status is set for 5 seconds or less"; cleared when the bot sends a message.
  Re-send every ~4s. Not supported in channels.
- `setMessageReaction`: `chat_id`, `message_id`, `reaction: ReactionType[]`
  (bots: at most one), `is_big`. `ReactionTypeEmoji {type:"emoji", emoji}` from
  the fixed 73-emoji set (❤ 👍 👎 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡
  🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃
  🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡).
  Empty array clears. No paid reactions.
- `answerCallbackQuery`: `callback_query_id`, `text` 0-200, `show_alert`,
  `url`, `cache_time`. Clients show a progress bar "until you call
  answerCallbackQuery", so always answer.
- `deleteMessage`/`deleteMessages`: only messages < 48h old; bots can delete
  own messages anywhere, incoming only in private chats or when admin with
  `can_delete_messages`.
- `sendDocument`/`sendPhoto`: multipart (`document`/`photo` as file part, or
  `file_id`, or URL). Upload limits 10 MB photo, 50 MB other; by-URL 5 MB /
  20 MB. `caption` 0-1024 chars.

## 5. Rate limits

~1 msg/s per chat, 20 msg/min per group, ~30 msg/s overall (up to 1000/s with
`allow_paid_broadcast`). Excess: 429 + `retry_after`; while blocked, all calls
fail. Edit limits are undocumented; community reports edits on one message
trigger 429 well below 1/s sustained. Text > 4096: 400 `message is too long`.

## 6. Streaming

- Send-then-edit at ~1s cadence is the established pattern (OpenClaw uses a
  hard 1s throttle); throttle by time and by delta size, skip identical text,
  honour `retry_after`, split into new messages past 4096 chars.
- Native streaming exists: `sendMessageDraft` (9.3, all bots since 9.5,
  Mar 2026): `chat_id` (private chats only), `draft_id` (non-zero; same id
  animates updates), `text` 0-4096 (empty = "Thinking..." placeholder),
  `parse_mode`, `entities`, `message_thread_id`, `can_stop`, `keep_on_stop`
  (10.3). Draft is ephemeral (~30s preview); finish with a real `sendMessage`.
  User pressing stop yields `stopped_message_generation` update.
  `sendRichMessageDraft` (10.1) streams rich messages. Groups still need the
  edit pattern.

## 7. Ephemeral and threads

- Ephemeral messages exist since 10.2 (Jul 2026): pass
  `ephemeral_message_parameters {receiver_user_id, callback_query_id?, replace_callback_query_message?}`
  on `sendMessage` etc. in groups; only that user sees it. Edit via
  `editEphemeralMessageText` (`chat_id`, `receiver_user_id`,
  `ephemeral_message_id`). Delivery not guaranteed if the user is offline.
  `answerCallbackQuery` `show_alert` remains the lightweight option.
- Threads: forum topics = `message_thread_id` (supergroups with `is_forum`,
  and bots with topics enabled in private chats, 9.3). Reply chains =
  `reply_parameters.message_id` / inbound `reply_to_message`; no thread id
  for those.

## 8. Public endpoint

Not needed for `getUpdates`; only webhooks require HTTPS on 443/80/88/8443.

## 9. SDK

No official TypeScript SDK; grammY and telegraf are community. A plain
`fetch` client is feasible: JSON POST plus one multipart path. Needed surface
for an agent bot: `getMe`, `getUpdates`, `sendMessage`, `editMessageText`,
`sendChatAction`, `setMessageReaction`, `answerCallbackQuery`,
`deleteMessage`, `sendDocument`/`sendPhoto`, optionally `sendMessageDraft`,
`setWebhook`/`deleteWebhook`. About 10-12 endpoints, one shared envelope
decoder, and one retry helper keyed on `parameters.retry_after`.
