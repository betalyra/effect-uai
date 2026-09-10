# Subagent report: WhatsApp Business Cloud API (2026-09-06)

Raw research report. Summarised in [../../messenger.md](../../messenger.md).

## 1. Prerequisites

- Meta developer account + Meta app (Business type), a Meta Business
  Portfolio, a WhatsApp Business Account (WABA), a business phone number ID,
  and a permanent System User access token with
  `whatsapp_business_messaging`, `whatsapp_business_management`,
  `business_management`.
  https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- Dev: Meta auto-provisions a free test business number; it can only message
  recipient numbers you add in the dashboard (limit 5). Production: register
  your own number, business verification lifts caps.
- Pricing: since July 1, 2025 it is per-message, not per-conversation. Charged
  only for delivered template messages. Everything inside the 24h customer
  service window (opened by an inbound user message) is free.
  https://developers.facebook.com/docs/whatsapp/pricing

## 2. Inbound (webhook only, no polling)

- Verification: Meta GETs your URL with `hub.mode=subscribe`,
  `hub.verify_token`, `hub.challenge`; check the token, echo `hub.challenge`.
- Payload:
  `{object:"whatsapp_business_account", entry:[{id, changes:[{field:"messages", value:{messaging_product, metadata:{phone_number_id, display_phone_number}, contacts:[{wa_id, profile.name}], messages:[{from, id, timestamp, type, ...}], statuses:[{id, status:"sent"|"delivered"|"read"|"failed"}]}}]}]}`.
  https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
- Signature: header `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the
  raw body with the app secret; compare constant-time.
- Return 200 promptly; non-200 triggers retries with decreasing frequency.
  Retries produce duplicates, so dedupe on `messages[].id`. Do the LLM work
  async after acking.
- Inbound `type`s: `text`, `image`, `audio`, `video`, `document`, `sticker`,
  `location`, `contacts`, `reaction`, `interactive` (with `interactive.type` =
  `button_reply` `{id,title}` or `list_reply` `{id,title,description}`),
  `button` (template quick reply), `order`, `unsupported`. Media arrives as a
  media id; fetch URL via `GET /{media_id}` then download with the bearer
  token.

## 3. Outbound

- `POST https://graph.facebook.com/{version}/{phone_number_id}/messages`,
  `Authorization: Bearer <token>`, body
  `{messaging_product:"whatsapp", recipient_type:"individual", to:"<E.164>", type:"text", text:{body, preview_url?}}`;
  body max 4096 chars; response `{messages:[{id}]}`.
- Reply quoting: add `context:{message_id}` to any send.
- Reaction: `type:"reaction", reaction:{message_id, emoji}`; empty emoji
  string removes; target must be < 30 days old.
- Read receipt + typing indicator (same endpoint):
  `{messaging_product:"whatsapp", status:"read", message_id, typing_indicator:{type:"text"}}`;
  indicator auto-dismisses after 25s or when you reply.
  https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
- Interactive: `type:"interactive"` with `interactive.type:"button"` (max 3
  reply buttons, 20-char titles) or `"list"` (max 10 sections, 10 rows total).
- Outside the 24h window only approved templates (`type:"template"`) can be
  sent.
- Edit: no. Delete/unsend: no. Cloud API has no edit or revoke endpoint.

## 4. Restrictions

- 24h customer-service window; bot-initiated contact requires an approved
  template. Templates go through Meta review.
- No edit-in-place means no streaming; send whole chunks (typing indicator
  bridges latency, capped at 25s so re-send it for long generations).
- Groups: as of 2026 there IS a Groups API, but only for Official Business
  Accounts (OBA), max 8 participants, text/media/templates only, no
  interactive messages. For a normal WABA, assume 1:1 only.

## 5. Version and base URL

Base `https://graph.facebook.com/{version}/...`. Latest Graph API is v26.0
(July 29, 2026); v25.0 and v24.0 still supported.

## 6. Local development

No polling alternative; webhooks require a public HTTPS URL. Use ngrok or a
Cloudflare Tunnel and paste the URL + verify token in App Dashboard >
WhatsApp > Configuration.

## 7. SDK and feasibility

Meta's official `WhatsApp/WhatsApp-Nodejs-SDK` was archived June 7, 2023.
Plain `fetch` against 1 endpoint + 1 webhook route is all that is needed.
Feasible with modest surface: one HttpServer route (GET verify, POST with HMAC
check, immediate 200, fork processing), one `HttpClient` send function. Main
design constraints for an agent adapter: no streaming (chunked full sends),
4096-char splitting, typing-indicator keepalive, dedupe on message id, 24h
window awareness for proactive messages.
