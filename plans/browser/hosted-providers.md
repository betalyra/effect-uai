# Hosted cloud browser / browser-infrastructure-for-AI-agents landscape (2025-2026)

Raw research report. All data drawn from official docs/pricing pages. Items that
could not be verified against a primary source are marked **UNVERIFIED**.

The dominant integration pattern across nearly every provider: **create a
session via REST/SDK, receive a `wss://` URL, `chromium.connectOverCDP(wsUrl)`
with Playwright/Puppeteer.** CDP-over-WebSocket is the shared floor. What varies
is where the API key goes, the session-create control plane, proxy/CAPTCHA
bundling, and pricing units.

## AI / agent-focused browser platforms

### 1. Browserbase

- **Offers:** Headless Chromium; stealth/anti-bot; CAPTCHA solving; residential
  proxies; session recording/replay; live view; file downloads; persistent
  contexts/auth.
- **Protocol, BOTH REST control plane + CDP-over-WS data plane:**
  - Create: `POST https://api.browserbase.com/v1/sessions` (`projectId`
    optional; inferred from key). Returns `connectUrl` (WS) + `seleniumRemoteUrl`
    - `signingKey`.
  - Connect: `chromium.connectOverCDP(session.connectUrl)`.
  - WS base: `wss://connect.browserbase.com`; manual form
    `wss://connect.browserbase.com?apiKey=${KEY}&sessionId=${id}` (param order
    lightly UNVERIFIED; the SDK's `connectUrl` already embeds credentials).
- **Auth:** REST header `X-BB-API-Key`; WS credentials embedded in `connectUrl`
  query string.
- **Pricing:** Per-browser-hour + per-GB proxy. Free (1 hr, 3 concurrent, no
  proxy); Developer $20/mo (100 hrs, $0.12/hr overage, 25 concurrent, 1 GB then
  $12/GB); Startup $99/mo (500 hrs, $0.10/hr overage, 100 concurrent, 5 GB then
  $10/GB); Scale custom.
- **Target:** AI agents (also general automation). Closed source.

### 2. Steel.dev (Steel Browser)

- **Offers:** Headless Chromium; rotating/residential proxies; stealth; CAPTCHA
  solving; live viewers + replays; persistent cookies / automatic sign-in;
  extraction to HTML/markdown/PDF/screenshots. **Open source
  (steel-dev/steel-browser); cloud OR self-hostable.**
- **Protocol, BOTH REST + CDP-over-WS:**
  - Create: `POST https://api.steel.dev/v1/sessions` (self-host:
    `http://localhost:3000/v1/sessions`). Body e.g. `{proxyUrl, blockAds,
dimensions}`; default timeout 5 min, sessions up to 24h.
  - Connect: `chromium.connectOverCDP()`; verified WS form:
    `wss://connect.steel.dev?apiKey=${STEEL_API_KEY}&sessionId=${session.id}`.
- **Auth:** REST header `Steel-Api-Key`; WS apiKey in query string.
- **Pricing:** Launch $0/mo + usage ($30 one-time credits); Scale $250/mo +
  usage ($100/mo credits); Enterprise custom (1,000+ concurrent). Per-browser-hour
  / per-GB rates **UNVERIFIED** (not published on pricing page). Self-host = infra
  cost only.
- **Target:** AI agents (explicit: "Humans use Chrome, Agents use Steel"). Only
  open-source/self-hostable option here.

### 3. Hyperbrowser (hyperbrowser.ai)

- **Offers:** Headless Chromium; `useStealth` / `useUltraStealth` (enterprise);
  `useProxy` (datacenter + residential, BYO); native CAPTCHA solving (DataDome,
  Cloudflare Turnstile, reCAPTCHA, hCaptcha); `acceptCookies`; live view via
  `liveUrl`; recordings, persistent profiles, extensions; timeout 1-720 min.
- **Protocol, BOTH REST + CDP-over-WS:**
  - Create: `POST https://api.hyperbrowser.ai/api/session`.
  - Connect: `chromium.connectOverCDP(session.wsEndpoint)`; supports
    `&keepAlive=true`. WS host `connect.hyperbrowser.ai`. Exact query-string
    internals SDK-abstracted, **UNVERIFIED** whether apiKey appears literally.
- **Auth:** REST header `x-api-key`; WS uses pre-signed `wsEndpoint` returned by
  API.
- **Pricing:** Credit model, 1 credit = $0.001. Browser usage 100 credits/hr =
  **$0.10/browser-hour**; proxy 10,000 credits/GB = **$10/GB**; CAPTCHA ~75
  credits (~$0.075, lightly UNVERIFIED); scrape 1 credit/page; AI Extract $30/M
  tokens; HyperAgent/Browser Use 20 credits/step ($0.02). Plans/tier names from
  secondary sources UNVERIFIED (Free 1,000 credits/1 concurrent; concurrency
  ladder 1/25/100).
- **Target:** AI agents (explicit). Closed source (SDKs open).

### 4. Anchor Browser (anchorbrowser.io)

- **Offers:** Cloud Chromium; per-country proxies (e.g. `country_code:"it"`);
  session recording (`recording.active`, default on); **profiles** to persist
  authenticated sessions; timeout/idle controls; stealth + CAPTCHA bypass bundled
  (not separate line items). Live view UNVERIFIED.
- **Protocol, REST session-create then CDP-WS:**
  - Create: `POST https://api.anchorbrowser.io/v1/sessions`. SDK returns
    `session.data.cdp_url`.
  - Connect: `chromium.connectOverCDP(cdp_url)`; WS shape
    `wss://connect.anchorbrowser.io?apiKey={KEY}&sessionId={id}`.
- **Auth (mixed):** REST header `anchor-api-key` (keys start `sk-`); WS apiKey in
  query string.
- **Pricing:** Browser creation $0.01/browser; **$0.05/browser-hour**; proxy
  **$8/GB**; AI steps $0.01/step. Free ($5 credits/mo), Starter $50/mo, Growth
  $2,000/mo, Enterprise. (Some third-party sources cite $0.10/hr or $4/GB,
  UNVERIFIED; official docs = $0.05/hr, $8/GB.)
- **Target:** AI / computer-use agents specifically ("Secure Infrastructure for
  Computer Use Agents").

### 5. Browser Use Cloud (browser-use.com)

- **Offers:** Both an agent-task API (V2/V3 agents given a prompt) AND a raw
  cloud browser with direct CDP. Hardened/stealth Chromium fork,
  anti-fingerprinting, built-in residential proxies (195+ countries), persistent
  profiles, live view. CAPTCHA via stealth infra (not a documented standalone
  feature, UNVERIFIED).
- **Protocol, raw CDP-WS (no SDK needed) + REST agent API:**
  - Raw: `wss://connect.browser-use.com?apiKey=YOUR_API_KEY&proxyCountryCode=us`.
  - SDK session returns `cdp_url` (`https://uuid.cdpN.browser-use.com`; query
    `/json/version` for `webSocketDebuggerUrl`) + `live_url`. Params: `apiKey`,
    `proxyCountryCode`, `profileId`, `timeout` (15-240 min), screen dims.
  - REST agent base: `https://api.browser-use.com/api/v3`.
- **Auth:** API key in WS URL query string; REST key auth on
  `api.browser-use.com`.
- **Pricing:** Free (3 concurrent), Dev $29/mo, Business $299/mo, Scaleup
  $999/mo, Enterprise. Browser sessions **$0.02/hr** (public pricing; a docs page
  cited $0.06/hr, discrepancy flagged); V3 agent = tokens at 1.2x provider rates;
  V2 agent from $0.006/step + $0.01/task; proxy **$5/GB**; dedicated Box
  $1-$4/day.
- **Target:** AI agents (own "Browser Use 2.0" model); raw CDP serves general
  automation.

### 6. Scrapybara (scrapybara.com), SUNSET

- **Officially sunset Oct 15, 2025** (per Scrapybara X post 2025-09-26): no new
  VM creation/control, existing VMs halted. Marketing site still shows plans, but
  **not viable for new integrations.**
- **Offers (distinct, full desktop/VM sandboxes, not just browsers):** Instance
  types Ubuntu (full Linux desktop), Browser (lightweight Chromium), Windows
  (full desktop). Act SDK (unified computer-use loop, Py+TS), code exec,
  filesystem, env vars, notebooks, screenshots, bash, browser auth.
- **Protocol, REST + Py/TS SDK + Act SDK; CDP for Browser instances:**
  `GET /v1/instance/{id}/browser/cdp_url` returns `{cdp_url}` then
  `connectOverCDP`. Returned wss shape UNVERIFIED.
- **Auth:** REST header `x-api-key`.
- **Pricing:** Compute-hours + agent credits; Free (10 hrs/100 credits/5
  concurrent), Basic $29/mo, Pro $99/mo; top-ups $0.04/credit or BYO model key.
- **Target:** Computer-use agents (OpenAI CUA, Claude Computer Use).

## Platform / cloud-vendor browser offerings

### 7. Kernel (onkernel.com / kernel.sh), confirmed exists

- YC-backed, raised $22M (Oct 2025). Sandboxed Chromium in isolated VMs,
  cold-start <30ms-300ms, optional GPU. Stealth/anti-bot, CAPTCHA, residential
  proxies, built-in auth, persistent profiles, live view + MP4 replay,
  extensions, file uploads (paid).
- **Protocol, REST + SDK, exposing CDP + WebDriver BiDi:** `POST /browsers`
  returns `cdp_ws_url`, `webdriver_ws_url`, `browser_live_view_url`,
  `session_id`. Body: `stealth`, `headless`, `timeout_seconds` (10-259200),
  `profile`, `extensions[]`, `viewport`, `start_url`. SDK
  `client.browsers.create()` then connect Playwright to `cdp_ws_url`. CLI:
  `kernel create/deploy/invoke`. Literal `wss://` template not captured,
  UNVERIFIED.
- **Auth:** Bearer token in HTTP header `Authorization: Bearer <key>` (not in
  URL).
- **Pricing:** GB-second, no proxy charge. Headless $0.0000166667/sec, Headful
  $0.0001333336/sec, Headful+GPU $0.0008000016/sec. Free ($5 credits, 5
  concurrent), Hobbyist $30/mo, Startup $200/mo, Enterprise.
- **Target:** AI/web agents (primary), general automation supported.

### 8. Cloudflare Browser Run (formerly Browser Rendering)

- Managed headless Chromium. Two modes: **Quick Actions** (stateless `/content`,
  `/screenshot`, `/pdf`, `/snapshot`, `/scrape`, `/json`, `/links`, `/markdown`)
  and **Browser Sessions** (stateful, Puppeteer/Playwright/CDP/Stagehand). Does
  NOT market stealth/CAPTCHA/residential proxies (uses Cloudflare's own egress).
- **Protocol, three ways:**
  - Workers binding + `@cloudflare/puppeteer`: `puppeteer.connect(env.BROWSER)`
    (zero-config in a Worker; standard CDP internally since >=1.1.0).
  - CDP-over-WS from anywhere:
    `wss://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/browser-rendering/devtools/browser?keep_alive={MS}`,
    connect with `Authorization: Bearer` header.
  - REST: `POST /accounts/{account_id}/browser-rendering/{content|screenshot|pdf|...}`.
- **Auth:** (a) Workers binding (no token); (b) REST + CDP-WS use API token in
  `Authorization: Bearer` header (connect header, not in URL).
- **Pricing:** Free (Workers Free): 10 min/day, 3 concurrent. Paid (Workers
  Paid): 10 browser-hours/mo included then $0.09/hr; 10 concurrent
  (monthly-averaged) included then $2.00/browser. No separate REST per-request
  fee.
- **Target:** Both, now heavily marketed for AI agents, also general
  scraping/PDF/screenshot.

### 9. AWS, Amazon Bedrock AgentCore Browser Tool (+ Nova Act), confirmed exists

- Two distinct things: **AgentCore Browser Tool** = the hosted cloud browser;
  **Nova Act** = separate SDK/agent that drives it. No product literally named
  "AWS Nova Act browser service."
- **Offers:** Secure containerized ephemeral Chromium; session isolation; live
  view (watch + interact); session recording (custom browsers: DOM/actions/
  console/network to your S3, replayable in Console); CloudTrail + CloudWatch.
  Managed id `aws.browser.v1` or custom with IAM/network config. Sessions default
  15 min, max 8 hrs. No stealth/CAPTCHA/proxy features (enterprise/QA-oriented).
- **Protocol, CDP-over-WS via SDK-generated URL + headers:**
  ```python
  from bedrock_agentcore.tools.browser_client import browser_session
  with browser_session('us-west-2') as client:
      ws_url, headers = client.generate_ws_headers()
      browser = await chromium.connect_over_cdp(ws_url, headers=headers)
  ```
  Also separate Live View + Automation WebSocket endpoints. Libraries: Nova Act,
  Strands, Playwright.
- **Auth:** **AWS SigV4**, `generate_ws_headers()` produces ws URL + SigV4
  headers; IAM-governed. Not a simple API key.
- **Pricing:** AgentCore Runtime per-second, CPU $0.0895/vCPU-hour, Memory
  $0.00945/GB-hour (peak footprint; CPU billing pauses during I/O wait). No
  separate browser-tool license; Nova Act tokens billed separately.
- **Target:** AI agents (production UI automation, QA, computer-use),
  enterprise. Not for anti-bot scraping.

## Scraping-first vendors (brief background)

These bundle a headless browser with residential proxies + CAPTCHA solving +
anti-bot unblocking, exposed as CDP-over-WS with credentials embedded in the URL.
They lean **general scraping**, not agent frameworks. See
[scraping-vendors.md](scraping-vendors.md) for the full breakdown. Summary:

- **Bright Data Scraping Browser:** CDP-over-WS with basic-auth credentials in
  the URL: `wss://brd-customer-<id>-zone-<zone>:<password>@brd.superproxy.io:9222`.
  Per-GB pricing. No REST connect method.
- **ZenRows Scraping Browser:** CDP-over-WS with API key in the URL:
  `wss://browser.zenrows.com?apikey=...`. Per-GB + $0.09/hr session fee.
- **Oxylabs Headless Browser:** CDP-over-WS basic-auth in URL:
  `wss://<user>:<pass>@ubc.oxylabs.io`. Per-GB. Markets an AI-agent angle via MCP.
- **Zyte / Nimble:** REST/declarative, NOT CDP-over-WS.

## Synthesis

### Is there a common-denominator interface?

**Yes, CDP-over-WebSocket is the shared floor.** Effectively every provider
surveyed lets you `chromium.connectOverCDP(wsUrl)` (or Puppeteer
`connect({browserWSEndpoint})`). The canonical flow is uniform:

1. Create a session (REST `POST` or SDK call).
2. Receive a `wss://` CDP URL (named variously `connectUrl` / `wsEndpoint` /
   `cdp_url` / `cdp_ws_url` / `connect_url`).
3. Point Playwright/Puppeteer at it.

A thin abstraction "given a CDP wss URL, drive it with Playwright" unifies the
_data plane_ across Browserbase, Steel, Hyperbrowser, Anchor, Browser Use,
Kernel, Cloudflare, AWS, Bright Data, and ZenRows.

### What varies (the knobs that would NOT unify)

1. **Where the API key lives, the single biggest divergence:**
   - In the WS URL query string: Steel (`?apiKey=&sessionId=`), Browserbase
     (embedded in `connectUrl`), Anchor (WS side), Browser Use (`?apiKey=`),
     Bright Data (basic-auth `user:pass@host`), ZenRows.
   - In an HTTP header (Bearer/token/SigV4): Kernel (`Authorization: Bearer`),
     Cloudflare (`Authorization: Bearer` connect header), AWS (SigV4 signed
     headers via `generate_ws_headers()`), Scrapybara (`x-api-key`, REST only).
   - REST-side header names all differ: `X-BB-API-Key` / `Steel-Api-Key` /
     `x-api-key` / `anchor-api-key` / Bearer.
     This is a genuinely non-uniform field. Do not promise one auth shape.
2. **Session-create control plane** varies (`/v1/sessions` vs `/api/session` vs
   `/browsers` vs SDK-only vs Workers binding). Cloudflare Workers binding and
   AWS SigV4/IAM are structurally different (no plain API key at all).
3. **Bundled capabilities:** proxies / CAPTCHA / stealth are first-class and
   bundled for agent+scraping platforms (Browserbase, Steel, Hyperbrowser,
   Anchor, Browser Use, Kernel, Bright Data, ZenRows) but absent/unmarketed for
   the hyperscaler offerings (Cloudflare, AWS).
4. **Pricing units do not unify:** per-browser-hour (Browserbase, Hyperbrowser,
   Anchor, Cloudflare, Browser Use), GB-second (Kernel), vCPU-hour + GB-hour
   (AWS), credit pools (Steel, Hyperbrowser, Scrapybara), per-GB proxy (everyone
   with proxies). Proxy is almost always a separate per-GB line item ($5-$12/GB).
5. **Scope of the "browser":** most are a single Chromium tab/context; Scrapybara
   (sunset) and AWS/Kernel-style offerings extend to full desktop VMs /
   computer-use surfaces.

### "Connect your own Playwright over CDP" vs "proprietary high-level API"

- **Pure connect-your-own-Playwright-over-CDP (infra only):** Steel,
  Browserbase, Hyperbrowser, Anchor, Kernel, Cloudflare (Sessions mode), AWS
  AgentCore, Bright Data, ZenRows. These give you a CDP endpoint and get out of
  the way.
- **Also offer a proprietary high-level API on top:**
  - Agent-task API (give a prompt, it drives the browser): Browser Use Cloud
    (V2/V3), Hyperbrowser (HyperAgent), Scrapybara (Act SDK), + AWS Nova Act as a
    separate driving SDK.
  - Stateless REST scrape/screenshot/pdf endpoints: Browserless (`/content`,
    `/pdf`, `/screenshot`, `/function`, `/scrape`, `/unblock`, BrowserQL),
    Cloudflare Quick Actions, Steel (extraction), Hyperbrowser (scrape/extract).
- **Binding-based (not a URL at all):** Cloudflare Workers binding is a unique
  fourth model, `puppeteer.connect(env.BROWSER)` with no token inside a Worker.

**Bottom line for a unifying abstraction:** target `connectOverCDP(wsUrl)` as the
common contract; treat the wss URL (already-signed vs needs-header) as the one
field that must stay provider-typed. Auth placement (URL query vs Bearer header
vs SigV4) and the session-create call are the parts that will not unify.
Proxy/CAPTCHA/stealth toggles are per-provider and should not be promised as a
shared default.

### Verification caveats

- **Scrapybara** is officially sunset (Oct 15, 2025) despite a live marketing
  site. Do not build on it.
- **Browser Use** hourly rate: public page $0.02/hr vs a docs page $0.06/hr.
  Reconcile before quoting.
- **Steel** per-browser-hour / per-GB rates not published (credit tiers only).
- **Hyperbrowser** exact wsEndpoint query internals and CAPTCHA per-solve cost
  UNVERIFIED.
- **Anchor** per-hour/proxy figures vary across third-party reviewers; official =
  $0.05/hr, $8/GB.
- **Bright Data / ZenRows / Oxylabs / Zyte / Nimble** numbers are background-level
  (see scraping-vendors.md for the verified pass).
