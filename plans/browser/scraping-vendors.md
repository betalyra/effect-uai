# Scraping browser offerings, per-vendor report

Raw research report. Background material: these are scraping-first vendors, not
AI-agent frameworks. Included to confirm the CDP-over-WebSocket thesis holds even
here. Main platforms are in [hosted-providers.md](hosted-providers.md).

Cross-cutting confirmation: Bright Data, ZenRows, and Oxylabs all expose a **real
cloud Chrome over CDP-via-websocket** that you point `connectOverCDP()` at,
bundled with residential proxies + CAPTCHA solving + anti-bot. Zyte and Nimble do
NOT do this (see below), they are REST/declarative, not CDP-websocket. All lean
**general scraping**, not AI-agent-first (Oxylabs is the closest to marketing an
AI-agent angle via MCP).

## 1. Bright Data, Browser API (a.k.a. Scraping Browser)

**What they offer:** Cloud-hosted headless Chrome; Unlocker anti-bot algorithm
(proxy rotation, header/fingerprint customization, cookie handling, auto-retries);
automatic CAPTCHA solving (toggleable); residential proxies (400M+ IPs,
geo-targeting); live browser debugging via Chrome DevTools; screenshots. **No**
session recording or persistent contexts documented (UNVERIFIED as features).

**Protocol / interface, CDP over websocket. Exact form:**

```
wss://brd-customer-<CUSTOMER_ID>-zone-<ZONE_NAME>:<PASSWORD>@brd.superproxy.io:9222
```

- Port **9222** for Playwright/Puppeteer (wrong port -> 407). Selenium uses
  **9515**.
- Connect via `playwright.chromium.connectOverCDP(endpointURL)` /
  `puppeteer.connect({ browserWSEndpoint })`.
- Bright Data extends CDP with custom commands: `Captcha.setAutoSolve`,
  `Captcha.solve`, `Proxy.setLocation`, `Proxy.useSession`, `Emulation.setDevice`,
  `Unblocker.enableAdBlock`, `Page.inspect`.
- **REST API: NO.** Docs state explicitly: "the only way to connect to Browser
  API is via WebSocket or HTTPS endpoints using your zone credentials... There is
  no REST API connection method at this time."

**Auth model:** Basic-auth embedded in the websocket URL. Username =
`brd-customer-<id>-zone-<zone>`, password after the colon.

**Pricing:** Per-GB of traffic (no per-request/per-hour).

- Pay-as-you-go: **$8/GB**
- $499/mo -> 71 GB (**$7/GB**)
- $999/mo -> 166 GB (**$6/GB**)
- $1,999/mo -> 399 GB (**$5/GB**)
- Enterprise: custom

**Target:** General scraping primarily; markets a secondary AI-agent navigation
angle but framing is scraping-first.

Docs: docs.brightdata.com/scraping-automation/scraping-browser/features,
docs.brightdata.com/scraping-automation/scraping-browser/faqs,
brightdata.com/products/scraping-browser.

## 2. ZenRows, Scraping Browser

**What they offer:** CDP-compatible cloud browser; residential proxies;
CAPTCHA/anti-bot handling; geo/region + country selection; session TTL control.
Works with Puppeteer, Playwright, and any CDP tool.

**Protocol / interface, CDP over websocket. Exact form:**

```
wss://browser.zenrows.com?apikey=<YOUR_ZENROWS_API_KEY>
```

- Connect via `p.chromium.connect_over_cdp(connection_url)`.
- Parameters (region, country, session TTL) documented with both SDK and
  direct-WebSocket-URL examples.
- **REST API:** ZenRows also has a separate **Universal Scraper API** (REST)
  product, but the Scraping Browser itself is the CDP-websocket product. (Exact
  REST endpoint for the Scraper API: UNVERIFIED in this pass.)

**Auth model:** API key as a **query parameter** (`?apikey=...`) in the websocket
URL. Not basic-auth-in-URL.

**Pricing:** Usage credits + per-GB bandwidth + hourly session fee.

- Developer plan: **$69/mo** ($69 credits), 20 concurrent, ~12.73 GB at
  **$5.50/GB**
- Bandwidth **$5.50/GB** entry, down to **~$2.73-2.80/GB** at Enterprise (top
  tier ~1.07 TB, 400 concurrent)
- **Plus $0.09 per hour** of scraping-browser session time

**Target:** General scraping.

Docs: docs.zenrows.com/scraping-browser/get-started/playwright,
docs.zenrows.com/scraping-browser/faq/pricing, zenrows.com/pricing.

## 3. Oxylabs, Headless Browser

**What they offer:** Cloud-hosted remote Chrome **and Firefox**; CAPTCHA solving
(hCaptcha, reCAPTCHA, Cloudflare Turnstile); 175M+ residential proxies with
country/city/state geo-targeting; full JS rendering. Works with Puppeteer,
Playwright, CDP tools, and **MCP (Claude Desktop / Cursor)**.

**Protocol / interface, CDP over websocket. Exact form:**

```
wss://<USERNAME>:<PASSWORD>@ubc.oxylabs.io
```

- US entry point: `wss://<USERNAME>:<PASSWORD>@ubc-us.oxylabs.io`
- Connect via `chromium.connectOverCDP(browserUrl)`.

**Auth model:** Basic-auth embedded in the websocket URL (`username:password@host`).

**Pricing:** Per-GB tiers (also gated behind dashboard/sales for some tiers).

- Starter: **$6/GB** ($300/mo for 50 GB)
- Advanced: **$5.50/GB** ($550/mo for 100 GB)
- Premium: **$4.70/GB** ($1,410/mo for 300 GB)
- Enterprise: custom
- (Note: Oxylabs' separate **Web Scraper API** is a different REST product,
  starts $49/mo, ~$1.6/1,000 results.)

**Target:** General scraping, but Oxylabs markets the strongest **AI-agent**
angle of the three via native MCP integration ("automate browsing... with AI
agents like Claude, Cursor").

Docs: oxylabs.io/products/headless-browser,
developers.oxylabs.io/scraping-solutions/headless-browser/chrome.

## 4. Zyte, Zyte API (NOT a CDP-websocket product)

**Interface, REST, not CDP-websocket.** This is the key differentiator.

- Endpoint: `POST https://api.zyte.com/v1/extract`
- Browser automation is done via a declarative JSON **`actions`** array
  (type/click/wait/browserScript), executed server-side; outputs `browserHtml`,
  `screenshot`, `networkCapture`. You do NOT connect Playwright/Puppeteer over a
  websocket; Zyte publishes migration guides _away from_
  Playwright/Puppeteer/Selenium/Splash onto this REST model.

**Auth:** HTTP Basic Auth, API key as username with empty password (`--user
YOUR_ZYTE_API_KEY:`).

**Pricing:** Per-request, tiered by target difficulty and monthly commitment.
PAYG; commitments $100/$200/$500/mo unlock discounts (e.g. simple HTTP as low as
~$0.06/1,000 at the $500 tier; browser/protected requests substantially higher).
Exact browser-action per-request rate card: UNVERIFIED in this pass.

**Target:** General scraping.

Docs: docs.zyte.com/zyte-api/usage/browser.html, docs.zyte.com/zyte-api/pricing.html.

## 5. Nimble, Browser / Browserless Drivers

**Interface:** Nimble offers "Browserless Drivers" combined with residential
proxies + an unblocker, positioned for scraping/automation, with pay-as-you-go
pricing. **Whether Nimble exposes a raw CDP-over-websocket connect endpoint (vs. a
REST/driver abstraction), the exact `wss://` shape, auth model, and
per-GB/per-request numbers: UNVERIFIED**, could not be confirmed from official
Nimble docs in this pass (search surfaced only third-party comparison pages).
Recommend a direct fetch of nimbleway.com docs to confirm before relying on it.

## Summary table

| Vendor      | CDP-ws?    | Endpoint shape                                                    | Auth                     | Pricing                          |
| ----------- | ---------- | ----------------------------------------------------------------- | ------------------------ | -------------------------------- |
| Bright Data | Yes        | `wss://brd-customer-<id>-zone-<zone>:<pw>@brd.superproxy.io:9222` | basic-auth in URL        | per-GB $8 to $5; no REST API     |
| ZenRows     | Yes        | `wss://browser.zenrows.com?apikey=<key>`                          | apikey query param       | per-GB $5.50 to $2.73 + $0.09/hr |
| Oxylabs     | Yes        | `wss://<user>:<pw>@ubc.oxylabs.io` (`ubc-us` for US)              | basic-auth in URL        | per-GB $6 to $4.70               |
| Zyte        | No (REST)  | `POST https://api.zyte.com/v1/extract` + `actions`                | basic-auth (key as user) | per-request, commit tiers        |
| Nimble      | UNVERIFIED | UNVERIFIED                                                        | UNVERIFIED               | UNVERIFIED                       |

**Verification gaps flagged:** Nimble entirely (all fields); Zyte exact
browser-action per-request rate; ZenRows Universal Scraper REST endpoint shape;
whether Bright Data / Oxylabs offer session recording or persistent contexts.
