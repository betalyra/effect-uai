# Does a "browser use" capability belong in effect-uai?

Raw research report. A concrete ledger from how Browserbase, browser-use,
Stagehand, Playwright-with-LLMs, and the computer-use models (Anthropic Computer
Use, OpenAI Operator/CUA, Google Mariner) are actually used in 2025-2026.

## TL;DR verdict

A browser is **genuinely additive** over the existing three primitives (web
search, web reading, sandbox). It unlocks the ~80-85% of the web behind
auth/JS/UI that a "fetch and clean" reader cannot touch: login-gated content,
multi-step flows, forms, downloads-behind-auth, dashboards. That part of the FOR
case is real and well-attested.

But it fits effect-uai's stated shape **badly**. The library's whole thesis is
"one turn, one tool call, State is yours, the loop is yours, we own the wire and
meet you at a `Stream<TurnEvent>`." A browser is the opposite: long-lived,
stateful, session-lifecycle-heavy, no clean "one call in, one value out." It is
an _app-level agent loop_, not a wire primitive. **Strong recommendation: defer
the agentic browser; if anything, add only a thin stateless read primitive
(JS-rendered URL to markdown), which is really just an upgrade to the existing
reader, not a new capability.** The industry itself moved to "browser as
fallback, not browser-first" in 2026, and the two flagship consumer agentic
browsers (OpenAI Operator, Google Mariner) were both killed.

## 1. What genuinely REQUIRES a full interactive browser (that a reader cannot do)

A "fetch URL and clean it" reader fails the moment the value requires _state_ or
_action_. Concrete, attested cases:

- **Login-gated / authenticated content.** Vendor portals, SaaS dashboards,
  internal legacy tools with no API. Browserbase's pitch: "allow agents to
  authenticate on behalf of humans with a real identity." A key pattern is
  credential-vault injection where "the LLM never sees the credentials",
  separating credential management from decision-making. A reader has no session,
  no cookie jar, no MFA handling.
- **Multi-step flows / forms.** Travel booking is the canonical example: open
  portal, authenticate, search with parameters, fill multi-page forms with
  conditional logic, confirm, download the receipt. Also: job applications,
  procurement/vendor registration, government forms, checkout. This is sequential
  state mutation, not extraction.
- **Infinite scroll / lazy-loaded / AJAX content.** Content that "appears in the
  browser but not in the HTML source." Requires scrolling to trigger loads.
- **Clicking through SPAs / content behind interaction.** Data hidden behind
  buttons, tabs, filters, pagination. Firecrawl's FIRE-1 agent exists precisely
  to "click buttons, paginate, and fill inputs."
- **Downloading files behind auth.** Invoices from vendor portals, exports from
  dashboards. Cited as an _ideal_ pilot use case because time-saved is measurable
  and failures are obvious.
- **Write actions with real effects.** Submitting, booking, purchasing. (Note:
  2026 consensus is nobody runs these fully unattended, they require approval
  gates.)

Sources: [Browserbase agents docs](https://docs.browserbase.com/use-cases/agents),
[Skyvern travel booking](https://www.skyvern.com/blog/automate-travel-booking-browser-agents/),
[Firecrawl best browser agents](https://www.firecrawl.dev/blog/best-browser-agents),
[awflow: why agents need a browser](https://awflow.io/why-ai-agents-need-a-browser-not-just-an-api/).

## 2. How much is ALREADY subsumed by JS-rendering readers (Firecrawl/Jina/Exa/Tavily)

Honest answer: **most of the naive "read a page" case is already covered, and a
browser is overkill there.**

- JS-rendering readers already execute JavaScript server-side and return clean
  markdown. Firecrawl, Jina Reader (ReaderLM-v2), Exa, Tavily all do this. For
  "the content is there but requires a JS render," you do **not** need a browser;
  the existing web-reading primitive (if it JS-renders) or an upgrade to it
  covers it.
- Firecrawl even blurs the line: it "pairs markdown output with crawling, search,
  **and browser automation** in one platform", its FIRE-1 agent
  clicks/paginates/fills inputs _inside the reader product_. So the reader vendors
  are absorbing the light-interaction cases.
- The reader's ceiling is **read-only, stateless, single logical page (or
  crawl)**. It breaks at: auth/session, sequential multi-step flows, and write
  actions.

So the delta a browser adds over a _good_ JS-rendering reader is narrow but real:
**statefulness (auth/session) + action (click/type/submit/download).** If the
reader does not yet JS-render, adding a browser to solve "the page was blank" is
solving the wrong problem, upgrade the reader instead.

Sources: [Firecrawl vs Jina](https://www.firecrawl.dev/alternatives/firecrawl-vs-jina-ai),
[Firecrawl JS rendering glossary](https://www.firecrawl.dev/glossary/web-scraping-apis/what-is-javascript-rendering-web-scraping),
[Apify: Jina vs Firecrawl](https://blog.apify.com/jina-ai-vs-firecrawl/).

## 3. Computer-use models vs hosted-browser providers, is the browser just the sandbox?

Yes. The clean mental model that emerged: **the computer-use model is the brain;
the hosted browser is the sandbox/hands it acts in.**

- Anthropic Computer Use, OpenAI CUA/Operator, and Gemini computer-use all "see"
  a screenshot, reason, then emit click/type/scroll actions. They are _policies_,
  not infrastructure.
- Browserbase explicitly positions itself as the substrate: it ran evals for
  Microsoft on "deterministic browser infrastructure" for "Gemini, OpenAI CUA,
  and other frontier models," handling rate limits, retries, action caching,
  anti-bot. Agents on Vercel Sandbox "connect to remote browsers over CDP." So
  the provider = the environment the CUA model drives.
- **Big 2025-2026 caveat, the consumer agentic-browser thesis retreated:**
  - OpenAI **Operator was deprecated by August 2025** and folded into ChatGPT
    Agent.
  - Google **killed Project Mariner (May 2025)**, "the industry pivots to
    API-first agents"; screenshot-driven agents that "click through interfaces
    like clumsy interns are losing ground to API-first tools."
  - CUA models fail hard on the hard parts: ~36-60% failure on modern CAPTCHAs;
    **100% failure on password entry by design**; Cloudflare (~20% of the web)
    blocks AI bots by default and deploys "AI Labyrinth."

Sources: [OpenAI Operator](https://openai.com/index/introducing-operator/),
[AI2Work: Google kills Mariner](https://ai2.work/blog/google-kills-project-mariner-as-the-industry-pivots-to-api-first-agents),
[Browserbase x Microsoft evals](https://www.browserbase.com/blog/training-computer-use-models-in-the-real-world-with-microsoft),
[Capsolver 2026 CAPTCHA guide](https://www.capsolver.com/blog/web-scraping/2026-ai-agent-captcha),
[BrowserAct on Cloudflare](https://www.browseract.com/blog/ai-agent-cloudflare-fail-fix).

## 4. Failure modes and reasons to DEFER / DECLINE

This is where the case against a browser _abstraction in effect-uai specifically_
is strongest.

**a. It has no "one call in, one value out" shape, it's inherently stateful.**
The reader is `URL -> markdown`. A browser is `session -> [act, act, act,
observe, act...] -> maybe a value`. Session lifecycle (create / persist cookies /
cleanup / error-recover / pool for concurrency) is the API. This directly
contradicts effect-uai's stated identity: "one turn, one tool call," "State is
yours, the loop is yours."

> Editor's note (post-research correction): this specific point is **wrong**.
> effect-uai's `Sandbox` capability is already a stateful, scoped, multi-method
> live handle (`create => Effect<SandboxInstance, E, Scope>` with
> `exec`/`spawn`/`files`), so a stateful browser session is on-pattern, not
> off-thesis. See section 7 of the parent [browser.md](../browser.md) for the
> corrected analysis. Points (c)-(f) below still stand; (b) is mitigated by
> keeping the loop in a recipe, exactly as Sandbox does.

**b. It's an app-level agent loop, not a wire primitive.** The
act/observe/extract loop _is_ an agent loop, exactly the thing effect-uai
deliberately does **not** own ("no orchestrator, no graph").
Stagehand/browser-use/Skyvern **are** that loop. Wrapping one means shipping an
opinionated loop, betraying the library's thesis.

**c. Huge, unstable surface area.** Even the specialists keep thrashing the
abstraction: Stagehand v3 and browser-use both **dropped Playwright and went
CDP-native** because "adapters obscure important details about the underlying
browsers." One team concluded agents "shouldn't have to know CDP Targets," then
reversed and gave the LLM raw CDP. If the category leaders can't settle the
abstraction, a low-level primitives library shouldn't freeze one now.

**d. Cost, latency, flakiness.** Real browsers are heavy (hosted-browser-minute
pricing), slow, and non-deterministic. CAPTCHA solving adds per-solve cost and
latency. Nobody runs consequential writes unattended in 2026; every real
deployment needs approval gates + failure monitoring, which is _policy_ (the
users' territory), not wire.

**e. Legal/ToS/anti-bot liability you'd be endorsing.** Public unauthenticated
scraping is broadly OK post-_hiQ v. LinkedIn_, but the interesting browser cases
are the risky ones: authenticated access can be framed as CFAA "unauthorized
access"; logging in means you accepted ToS that often forbid automation (civil
breach); EU regulators fine for scraping public _personal_ data. A stateless
reader keeps you in the safe zone; a stateful auth-driving browser pushes the
library's name into the liability conversation.

**f. The market moved to "browser as fallback, not browser-first."** 2026
consensus architecture: try API, fall back to scrape (reader), fall back to
browser _only_ when interaction is required and scraping can't work. "The
classifier must earn every session." That ordering means the browser is the last,
heaviest, least-used tier, a poor fit for a first-party core primitive.

Sources: [browser-use: leaving Playwright for CDP](https://browser-use.com/posts/playwright-to-cdp),
[Webfuse CDP vs Playwright](https://www.webfuse.com/blog/cdp-vs-playwright-vs-puppeteer),
[webclaw: browser-fallback signals](https://webclaw.io/blog/anti-bot-scraping-api-2026-browser-fallback-signals),
[Browserless: is web scraping legal](https://www.browserless.io/blog/is-web-scraping-legal),
[Coronium: hiQ / Meta v Bright Data / Reddit v Perplexity](https://www.coronium.io/blog/is-web-scraping-legal-2026).

## The balanced ledger

**Strongest arguments FOR adding a browser:**

1. Unlocks the ~80-85% of the web behind auth/JS/UI that readers structurally
   cannot reach ("APIs see 15% of the web").
2. Auth + session + action (login, forms, multi-step flows, downloads-behind-auth,
   dashboards) is a real, distinct capability the other three primitives
   genuinely do not cover.
3. It's the sandbox layer the computer-use models need; if effect-uai wants to
   support Anthropic Computer Use / CUA end-to-end, _something_ has to be the
   hands.
4. Hosted providers (Browserbase et al.) already commoditize the hard infra
   (stealth, pools, CDP), so you'd wrap a service, not build a browser farm.

**Strongest arguments AGAINST / to defer:**

1. No clean "one call in, one value out" shape, it's inherently stateful, which
   contradicts effect-uai's entire "own the wire, not the loop" thesis.
2. It _is_ an app-level agent loop (act/observe/extract), the exact thing the
   library refuses to own.
3. Abstraction is unstable and huge; even Stagehand and browser-use ripped out
   Playwright for CDP; picking a shape now risks churn.
4. Much of the naive case is already covered by JS-rendering readers; the true
   delta (auth + write) is the small, risky, expensive, flaky part.
5. Cost/latency/non-determinism/CAPTCHA/anti-bot; needs approval gates that are
   the user's policy.
6. Legal/ToS exposure concentrated in exactly the authenticated cases a browser
   enables.
7. Market momentum: Operator and Mariner killed; consensus is "browser as
   fallback," the last tier, weak justification for a first-class core primitive.

**Concrete recommendation.** Defer the agentic/interactive browser. If you want to
close the most-requested gap cheaply and _on-thesis_, add only a **stateless,
JS-rendered read** ("render this URL, return markdown"), which is an upgrade to
the existing web-reading primitive, keeps the `URL -> value` shape, and stays in
the legally-safe read-only zone. Leave the stateful act/observe/session loop to
the app layer (Stagehand/browser-use/Browserbase), where the community already
agrees it belongs.
