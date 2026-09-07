---
"@effect-uai/core": minor
"@effect-uai/telegram": minor
---

Add the `Messenger` capability and the first provider, `@effect-uai/telegram`.

**Core** (`@effect-uai/core/Messenger`, `@effect-uai/core/MessengerError`):

- `Messenger` service tag: one inbound `events` stream (`Message` with an `addressed` flag, `Command`, `Reaction`, `Action`) and five outbound verbs: `post`, `edit`, `react`, `typing` (scoped, kept alive until the scope closes) and `stream` (progressive delivery of a `Stream<string>`).
- `Outbound` is a body plus envelope: `Messenger.text(body, { replyTo? })`, `Messenger.media(source, { caption?, filename? })` over the core `MediaSource`, and `Messenger.raw(payload)` as the platform escape hatch. Text is sent verbatim; each provider documents the markup it expects.
- Ambient targeting: `CurrentConversation` is a context tag with no default, established once per fiber with `Messenger.inConversation(ref)`. Posting outside a conversation is a compile error.
- `Messenger.streamViaEdits`, the post-then-edit strategy adapters without native streaming share: coalesces by time and growth, never resends unchanged text, honours `MessengerRateLimited.retryAfter`, rolls over past `limits.maxText`.
- `MessengerError`: `ConnectFailed`, `TransportClosed`, `RequestFailed`, `RateLimited`, `Unsupported`, with `describe`.
- `@effect-uai/core/testing/MockMessenger`: scripted events, recorded outbound calls.

**Telegram** (`@effect-uai/telegram/Telegram`): `layer({ token, parseMode?, pollTimeout?, stream? })` registers `Telegram` and `Messenger` over one long-poll `getUpdates` loop owned by the layer's scope. Plain `HttpClient`, no SDK. The addressed rule (DM, `@bot` mention, reply to the bot), the offset-0 command rule, `answerCallbackQuery` auto-ack, `retry_after` as `MessengerRateLimited`, media over `sendPhoto` / `sendAudio` / `sendVideo` / `sendDocument`, and a plain-text fallback when Telegram cannot parse the markup.

Recipe: `recipes/messenger-agent`, the agentic loop living in a Telegram chat with web search, one fiber per conversation.
