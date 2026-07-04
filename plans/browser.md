# Browser use capability: research and recommendation

Status: research / for discussion. Evaluates whether effect-uai should add a
"browser use" capability (hosted or local browser sessions for agents),
companion to [web-extract.md](web-extract.md) and [search.md](search.md). This
doc is a decision aid, not a build spec. Researched 2026-07 across the
AI/agent-focused browser platforms (Browserbase, Steel, Hyperbrowser, Anchor,
Browser Use, Kernel, Cloudflare, AWS AgentCore), the local/OSS tooling
(Playwright, obscura, Stagehand, browser-use), and real agent use cases. Full
subagent reports live in [browser/](browser/): [hosted-providers.md](browser/hosted-providers.md),
[local-tooling.md](browser/local-tooling.md), [use-cases.md](browser/use-cases.md),
[scraping-vendors.md](browser/scraping-vendors.md).

## TL;DR recommendation

A `BrowserSession` capability fits effect-uai's patterns: it is a near-twin of
the existing `Sandbox` capability, a stateful scoped live handle with a small set
of stable methods. The design question ("does a browser belong in the library")
resolves to yes; what remained was scope and demand. The plan is to **proceed with
a scoped phase 1**: a Layer-A `BrowserSession` over four providers, plus one
flagship recipe (agent usability testing). More providers, more recipes, and a
read-only `WebRead` variant are deferred. Phase 1 scope is in section 9.

- **A browser is additive over search, read, and sandbox.** It unlocks the part
  of the web behind auth, JS interaction, and multi-step UI that a "fetch and
  clean" reader structurally cannot reach: login-gated portals, forms, multi-step
  flows, downloads behind auth, dashboards.
- **The action surface is small and stable.** `goto` / `click` / `scroll` /
  `type` / `waitFor` / `content` / `screenshot` / `evaluate` are the CDP
  Input+Page domains, identical across every provider. Providers differ only in
  session creation, auth, proxy, and stealth (section 4), never in what "click"
  means. Scoping the capability to these typical actions is the most stable
  surface in the stack.
- **Keep the loop and the grounding out, as `Sandbox` already does.** Sandbox
  ships `exec`/`files` primitives and leaves "run, fix, repeat" to a recipe. A
  browser ships session + action + observation primitives and leaves "LLM decides
  what to click" to a recipe. The one contested, fast-moving piece, grounding
  (turning a page into something a model can pick an element from), lives in the
  recipe layer, not the provider abstraction. See sections 6 and 7.
- **Legal/ToS is the user's responsibility.** A library does not own what a
  developer points it at, just as `Sandbox` does not own the code you run. The
  only residual is not shipping ToS-violating example recipes.
- **Market context lowers urgency.** The flagship consumer agentic browsers
  (OpenAI Operator, Google Mariner) were killed in 2025 and consensus moved to
  "browser as last-resort fallback, not browser-first."

Details below: the design in section 7, the recipes in section 8, the concrete
phase 1 scope (providers, dependency, recipe) in section 9.

## 1. Two layers

The landscape reduces to a clean split, and getting it right is the whole
decision.

- **Layer A, the transport ("control a browser").** CDP (Chrome DevTools
  Protocol) over a WebSocket, optionally wrapped by Playwright/Puppeteer. A
  driver. Uniform and provider-agnostic: the same call surface whether the
  browser is launched locally or lives in a cloud. This is the layer a capability
  would wrap.
- **Layer A', the grounding / read model.** Turning a live page into something an
  LLM can act on: an accessibility tree with element refs (`@e1`), a screenshot
  with numbered boxes (set-of-marks), a raw DOM, or pixel coordinates. This is the
  fast-moving, contested piece. It belongs in the recipe layer, built from
  Layer-A observations, not baked into the provider abstraction.
- **Layer B, the agent loop ("LLM decides what to click").** Snapshot, let the
  model pick an action, execute via Layer A, repeat. This is browser-use,
  Stagehand, Skyvern, every computer-use model. Application composition, a recipe,
  not infrastructure.

The capability is Layer A only. Layers A' and B are recipes, exactly as the
sandbox-code-interpreter recipe is a recipe over the `Sandbox` primitives.

## 2. CDP-over-WebSocket is the universal substrate

Nearly every provider surveyed, hosted or local, agent-focused or scraping-first,
lands on the same integration:

1. Create a session (REST `POST` or SDK call).
2. Receive a `wss://` CDP URL (named variously `connectUrl` / `wsEndpoint` /
   `cdp_url` / `cdp_ws_url` / `connect_url`).
3. `chromium.connectOverCDP(wsUrl)` (Playwright) or `puppeteer.connect(...)`.

The same `connectOverCDP` entry point covers **launch-local Chromium**
(`--remote-debugging-port=9222`), **connect-remote hosted** (Browserbase et al.),
and **connect-OSS-engine** (obscura's partial CDP server). A single "given a CDP
wss endpoint, drive it" abstraction unifies the data plane across the entire
field.

Two caveats for any build:

- **Playwright wrapper vs raw CDP.** `connectOverCDP` routes through a Node
  Playwright relay, adding a hop and state-drift edge cases. browser-use and
  Stagehand both dropped Playwright for raw CDP citing per-call latency and hangs.
  Ergonomics favor Playwright; throughput favors raw CDP. Both terminate in the
  same CDP-over-WS pipe.
- **BiDi is emerging under CDP.** Puppeteer 24+ defaults to WebDriver BiDi (W3C,
  cross-browser) while keeping CDP for Chrome. CDP is still the Chrome substrate
  and the target of stealth patches; BiDi is the cross-browser future, not yet the
  universal floor.

## 3. Provider reality: AI/agent-focused platforms (researched 2026-07)

The control plane and knobs vary; the CDP-over-WS data plane and the action
surface do not. Numbers flagged UNVERIFIED could not be pinned to a primary
source. Full per-provider detail in [browser/hosted-providers.md](browser/hosted-providers.md).

| Provider          | Control plane -> connect                                                                                                    | Auth (key placement)                                    | Bundled proxy/CAPTCHA/stealth | Pricing unit                                       | OSS / self-host |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | :---------------------------: | -------------------------------------------------- | :-------------: |
| **Browserbase**   | `POST /v1/sessions` -> `connectUrl` -> `connectOverCDP`                                                                     | REST `X-BB-API-Key`; WS creds in URL                    |              yes              | per-browser-hour + per-GB proxy                    |       no        |
| **Steel.dev**     | `POST /v1/sessions` -> `wss://connect.steel.dev?apiKey=&sessionId=`                                                         | REST `Steel-Api-Key`; WS apiKey in query                |              yes              | credit tiers (per-hr/GB UNVERIFIED)                |  **yes** (OSS)  |
| **Hyperbrowser**  | `POST /api/session` -> `wsEndpoint` (`&keepAlive`)                                                                          | REST `x-api-key`; WS pre-signed                         |              yes              | credits: ~$0.10/browser-hr, ~$10/GB proxy          |    no (SDKs)    |
| **Anchor**        | `POST /v1/sessions` -> `cdp_url` -> `connectOverCDP`                                                                        | REST `anchor-api-key`; WS apiKey in query               |              yes              | $0.05/browser-hr, $8/GB proxy (UNVERIFIED)         |       no        |
| **Browser Use**   | raw `wss://connect.browser-use.com?apiKey=&proxyCountryCode=` (no SDK) OR REST agent API                                    | API key in WS query; REST key                           |              yes              | ~$0.02/browser-hr (docs say $0.06, flagged), $5/GB | no (own model)  |
| **Kernel**        | `POST /browsers` -> `cdp_ws_url` (+ `webdriver_ws_url`)                                                                     | `Authorization: Bearer` **header**                      |              yes              | GB-second (no proxy charge)                        |       no        |
| **Cloudflare**    | Workers binding `puppeteer.connect(env.BROWSER)`, OR CDP-WS at `/browser-rendering/devtools/browser`, OR REST quick-actions | Workers binding (none) / `Authorization: Bearer` header |            **no**             | $0.09/browser-hr after 10 free                     |       no        |
| **AWS AgentCore** | `browser_session()` -> `generate_ws_headers()` -> `connect_over_cdp(url, headers)`                                          | **AWS SigV4** signed headers (IAM)                      |            **no**             | vCPU-hour + GB-hour (Runtime)                      |       no        |
| **Scrapybara**    | SUNSET 2025-10-15, do not build on it                                                                                       | (was `x-api-key`)                                       |         (desktop VM)          | (was compute-hrs + credits)                        |       no        |

Notable shape differences beyond the table:

- **Browser Use, Hyperbrowser, AWS Nova Act** also ship a Layer-B agent-task API
  (give a prompt, it drives the browser). That is the loop, not infra, and out of
  scope for a Layer-A capability.
- **Cloudflare and AWS are the outliers**: no bundled proxy/CAPTCHA/stealth
  (enterprise/QA framing), and structurally different auth (Workers binding /
  SigV4) that does not fit a plain-API-key model.
- **Scraping-first vendors** (Bright Data, ZenRows, Oxylabs) use the same
  CDP-over-WS floor with credentials in the URL, bundling residential proxies +
  CAPTCHA. They are scraping products, not agent frameworks; background only. See
  [browser/scraping-vendors.md](browser/scraping-vendors.md).

## 4. What unifies, and what would not

**Unifies (the common contract):** a driveable CDP session and a fixed set of
actions on it. `goto`, `click`, `type`, `scroll`, `waitFor`, `content`,
`screenshot`, `evaluate` are identical everywhere because they are CDP verbs. A
`BrowserSession` capability abstracts cleanly over this.

**Does not unify (stays provider-typed, behind capability markers):**

1. **Where the API key lives**, the single biggest divergence. WS URL query
   string (Steel, Browserbase, Anchor, Browser Use, Bright Data, ZenRows) vs an
   HTTP header: Bearer (Kernel, Cloudflare) vs AWS SigV4 (AgentCore) vs a Workers
   binding with no token (Cloudflare). REST header names all differ. Do not
   promise one auth shape.
2. **Session-create control plane** (`/v1/sessions` vs `/api/session` vs
   `/browsers` vs SDK-only vs Workers binding).
3. **Bundled proxy / CAPTCHA / stealth** toggles: first-class for agent+scraping
   platforms, absent for hyperscalers. Provider-typed, never a promised default.
4. **Pricing units**: per-browser-hour, GB-second, vCPU-hour, credit pools. Not a
   code concern, but signals how differently these are modeled.
5. **Scope of "the browser"**: single Chromium tab/context (most) vs full desktop
   VM / computer-use surface (Scrapybara-style, AWS/Kernel-adjacent).

This is the same kind of provider divergence `Sandbox` already handles: a stable
common surface, with non-uniform infra features gated behind capability markers
and provider-typed requests.

## 5. The local / OSS option

For a runtime-native, no-cloud path (full detail in
[browser/local-tooling.md](browser/local-tooling.md)):

- **Playwright / Puppeteer**, the TS/Node baseline. `connectOverCDP` to a local
  `chromium --remote-debugging-port=9222`, same surface as remote.
- **obscura** (h4ckf0r0day/obscura), a from-scratch headless browser engine in
  Rust embedding V8 (no Chrome, no Node), implementing a partial CDP server: a
  drop-in remote-CDP endpoint you `connectOverCDP` into like any cloud provider,
  with built-in per-session stealth and tracker blocking. ~30 MB RAM, instant
  start. Caveat: partial CDP coverage; perf claims self-reported.
- **Stagehand** (browserbase/stagehand), first-class TypeScript, CDP engine, runs
  local or remote-Browserbase, with `act()`/`observe()`/`extract()` verbs. This is
  a Layer-B reference design (or an optional recipe dependency), not something the
  capability reabstracts.
- **browser-use / Skyvern / nodriver** are Python-only: reference designs, not
  dependencies for an Effect-TS library.

An Effect-TS library can build the whole Layer-A stack natively on CDP +
Playwright/Puppeteer + obscura, with no Python dependency, and point the same
abstraction at the hosted providers.

## 6. Use-case ledger: what a browser actually adds

Full version in [browser/use-cases.md](browser/use-cases.md).

### Genuinely requires an interactive browser (a reader cannot do it)

The reader (`url -> markdown`) fails the moment value requires state or action:

- **Auth-gated content**: vendor portals, SaaS dashboards, internal tools with no
  API. Needs a session, cookie jar, MFA.
- **Multi-step flows / forms**: travel booking, job applications, checkout,
  procurement. Sequential state mutation with conditional logic.
- **Infinite scroll / lazy-loaded / AJAX** content that exists in the live DOM but
  not the HTML source.
- **Clicking through SPAs**: data behind buttons, tabs, filters, pagination.
- **Downloading files behind auth**: invoices, dashboard exports.
- **Write actions**: submit, book, purchase (unattended writes need approval
  gates, which are user policy).

### Already covered by JS-rendering readers (browser is overkill)

Most of the naive "read a page" case is already handled by the existing
web-reading providers. Firecrawl, Jina, Exa, Tavily JS-render server-side and
return markdown; Firecrawl's FIRE-1 even clicks and paginates inside the reader
product. The reader's ceiling is read-only, stateless, single page (or crawl). The
delta a browser adds is narrow but real: statefulness (auth/session) + action
(click/type/submit/download). If a page comes back blank, the fix is a
JS-rendering reader, not a browser.

### Computer-use models: the browser is the sandbox

Anthropic Computer Use, OpenAI CUA/Operator, Gemini computer-use are policies (see
screenshot, reason, emit click/type/scroll). The hosted browser is the environment
they act in. Big 2025-2026 caveat: Operator was deprecated (folded into ChatGPT
Agent), Google killed Project Mariner, and CUA models fail hard on CAPTCHAs, on
password entry by design, and against Cloudflare's AI-bot blocking (~20% of the
web). The consumer agentic-browser thesis retreated; API-first with
browser-as-fallback won.

## 7. Shape: model it on `Sandbox`

A browser session is a stateful, scoped, multi-method resource. effect-uai already
ships exactly that shape in `Sandbox`
([packages/core/src/sandbox/Sandbox.ts](../packages/core/src/sandbox/Sandbox.ts)):

- `create(req) => Effect<SandboxInstance, E, Scope.Scope>`, a live handle whose
  lifetime is the scope; the finalizer destroys it. `attach` re-acquires,
  `destroy` is the cross-scope escape hatch, `list` enumerates.
- the instance carries many operations (`exec`, `execStream`, `spawn` returning a
  `ProcessHandle`, a `files` sub-service).
- provider-varying features (snapshots, volumes, ports, secret injection) sit
  behind capability markers rather than being forced to unify.

A `BrowserSession` maps onto this one-to-one:

```ts
// a live, driveable session; lifecycle is the scope, exactly like Sandbox
type BrowserSessionService = {
  readonly create: (
    req: CommonSessionRequest,
  ) => Effect.Effect<BrowserInstance, AiError.AiError, Scope.Scope>
  readonly attach: (id: SessionId) => Effect.Effect<BrowserInstance, AiError.AiError, Scope.Scope>
  // proxy / stealth / recording: capability-gated markers, not a shared floor
}

// representative core methods; full core verb list is in the prose below
type BrowserInstance = {
  readonly goto: (url: string) => Effect.Effect<void, AiError.AiError>
  readonly click: (selector: string) => Effect.Effect<void, AiError.AiError>
  readonly fill: (selector: string, text: string) => Effect.Effect<void, AiError.AiError>
  readonly select: (selector: string, value: string) => Effect.Effect<void, AiError.AiError>
  readonly scroll: (opts: ScrollOptions) => Effect.Effect<void, AiError.AiError>
  readonly waitFor: (selector: string) => Effect.Effect<void, AiError.AiError>
  readonly query: (selector: string) => Effect.Effect<ReadonlyArray<ElementInfo>, AiError.AiError>
  readonly snapshot: () => Effect.Effect<AxNode, AiError.AiError> // raw accessibility tree
  readonly content: (format?: "markdown" | "html") => Effect.Effect<string, AiError.AiError>
  readonly screenshot: (opts?: { selector?: string }) => Effect.Effect<Uint8Array, AiError.AiError>
  readonly cookies: CookieApi // get / set, for the auth path
  readonly evaluate: (js: string) => Effect.Effect<unknown, AiError.AiError>
}
```

**Scope discipline is the whole design.** The capability exposes the stable
actions plus raw observation (`content`, `screenshot`, optionally the raw CDP
accessibility tree as data). It does **not** expose a grounding model: the
element-numbering scheme, set-of-marks overlay, and a11y-vs-vision choice are
recipe concerns, built on top of the raw observations. It does **not** ship the
decide-loop: "LLM picks the next action" is a recipe composed from
`BrowserSession` + `LanguageModel`, mirroring the sandbox-code-interpreter recipe.
This keeps the README thesis ("State is yours. The loop is yours.") intact: the
capability owns the wire, the recipe owns the policy.

### The verb surface: a curated core plus an escape hatch

Aim for a curated subset that covers the general cases, not every CDP verb. Two
things make a small core safe:

- **A curated core.** Navigation and waiting (`goto`, `waitFor`); interaction
  (`click`, `dblclick`, `fill`, `type`, `press`, `hover`, `focus`, `select`,
  `check`/`uncheck`, `scroll`, `scrollIntoView`); observation (`content`,
  `screenshot`, `snapshot`, `query`); state (`cookies`, `evaluate`). Close to
  agent-browser's common set, covering agent browsing, form filling, and
  extraction. Drag-and-drop and file upload are deferred (see below).
- **`evaluate(js)` as the escape hatch.** Anything not wrapped (a rare gesture, a
  page-specific quirk) is reachable by running JS in the page, so the long tail
  never blocks a use case. That is why the core can stay small without losing
  generality.

Because it is all CDP, every one of these is uniform across providers; the split
that matters is CDP verbs (uniform, in the core) vs platform features (proxy,
stealth, recording, which vary and sit behind capability markers).

**Do not expose CDP itself.** CDP is the wire the adapter speaks, not the public
API; surfacing raw domains (`DOM.querySelector`, `Input.dispatchMouseEvent`) would
leak the wire. How much CDP gets implemented depends only on the transport: with
`playwright-core` you implement none (it speaks the full protocol; you map verbs
to its API); with a raw-CDP client you implement only the subset the core verbs
need (Page, Runtime, DOM, Input, plus Network/Storage for cookies). obscura
implementing full CDP is about it being a valid drop-in endpoint for Playwright,
not about the capability implementing CDP.

**Element inspection returns data, not handles.** Actions take a selector string
(CSS, so `#id` is just `#id`; optionally XPath, avoiding Playwright's proprietary
engine so the surface stays portable). `query(selector)` returns serializable
element data (tag, text, attributes, bounding box, a ref) and `snapshot()`
returns the raw accessibility tree, rather than live element handles, which are
stateful, go stale across navigation, and do not cross a provider boundary
cleanly. Turning either into numbered set-of-marks stays a recipe helper.

**Genuinely deferred, with reasons** (not cut for surface-count, but because each
is heavier or nicher than the core):

- `drag` (drag-and-drop): two mechanisms, neither a clean one-liner. Pointer-based
  DnD is just a stepped mouse/pointer sequence, better expressed as a recipe
  helper over `evaluate` and low-level input than a first-class verb; native HTML5
  DnD needs CDP's drag-intercept path or a JS-dispatched `DataTransfer`. Defer;
  revisit as a helper if a recipe needs it.
- `upload` (file upload): the OS file dialog cannot be scripted, so files are set
  via `setInputFiles` / `DOM.setFileInputFiles`, and remote browsers require
  transferring the bytes to the remote host first (a known browser-use edge case).
  Defer; when added, its contract should take file contents (bytes + name), not a
  local path, so it works uniformly local and remote.
- `pdf`: an output format, not an interaction; no phase-1 recipe needs it, and
  `Page.printToPDF` carries headless caveats. Add when a recipe wants it.
- low-level keyboard atoms (`keydown`/`keyup`/`inserttext`): `press`, `type`, and
  typing-at-focus cover the common cases; the atoms are for held modifiers or
  IME-style insertion. Add on demand.
- multi-tab (`--new-tab`) and frame targeting: real added state (tab lifecycle,
  frame handles); defer until a cross-tab or in-frame flow needs it.
- network interception (Fetch): powerful but advanced; defer.

Transport/tooling commands (`connect`, `stream`, `mcp`) are not capability surface
at all: `connect` is the adapter's job, the rest are agent-browser's packaging.

### Session lifetime

Inherit Sandbox's lifecycle verbatim: `create` returns a scope-bound handle
(finalizer disposes: close socket / REST destroy / kill process), `attach(id)`
reconnects with a detach finalizer for warm reuse across runs, `destroy(id)` is
the cross-scope escape hatch. Held in a wider scope a session stays warm to serve
many requests; bound with `Effect.scoped` it dies with one. A browser session is a
cost-bearing resource (remote billed per second, local holding memory), so this is
the same discipline as a sandbox, not an optional nicety.

Disposal has two independent layers, and a single `timeout` on the create request
wires up both:

- **Local enforcement (always).** `create` forks a scoped reaper
  (`Effect.sleep(timeout)` then idempotent teardown) so the session self-disposes
  on the caller's clock, promptly, regardless of backend. For local providers
  (Playwright, obscura) this is the only timeout that exists, they have no server
  clock, so without local enforcement `timeout` would be meaningless for them.
  After expiry, operations on the handle fail with a typed `SessionExpired`.
- **Provider backstop (where supported).** The same value is passed to the
  provider's server-side session cap, so a crashed or partitioned client (whose
  finalizers never run) still gets the paid session reclaimed. Insurance for the
  hard-failure case, not the primary control.

One knob drives both layers at the same value, on purpose, so they cannot
disagree. The invariant is **provider cap >= local reaper**: the local reaper is
the prompt primary; the provider cap is the late backstop for when the client
crashed and the reaper could not run. A provider cap shorter than the local
expectation is the bug (the backstop yanks the session before the primary fires,
producing a surprise dead session). Keeping them equal avoids the mismatch, and
the failure is clean: at expiry the handle is locally marked expired, so the next
call fails immediately with a deterministic `SessionExpired` rather than a late,
cryptic dead-socket error surfacing from the provider.

`timeout` is a hard max lifetime and a convenience: it disposes only the
capability's own resource, it does not interrupt unrelated work (the caller's next
session call simply fails `SessionExpired`). For precise control (interrupt the
whole job, race against a signal, deadline a sub-step, or dispose _earlier_ than
the cap) the caller composes `Effect.timeout` / `Effect.race` over the scoped
session; that stays the power tool, but a local race should be at or below the
session lifetime, never above it (racing past a session that is already gone is
meaningless). Idle semantics (reset the timer on each use) are a separate opt-in
(`idleTimeout`), since they need an activity touch on every call.

Three distinct failure modes, cleanly typed: `SessionExpired` (the session is
gone, hit its max lifetime or was destroyed), `Timeout` (the session is alive but
one operation exceeded its own per-op deadline), and Effect interruption (the
caller's own `Effect.race` / `Effect.timeout` over the usage fired).

With grounding and the loop scoped out, the two remaining considerations are
ordinary ones, and the same ones that applied to `Sandbox`:

1. **Demand** for the stateful auth+action case specifically (as opposed to
   read-only, which cheaper options cover).
2. **Maintenance cost** of N provider adapters, each with its own session-create
   and auth handshake (section 4).

## 8. Recipes

Recipes are where the browser primitive proves itself, composed with
`LanguageModel`, structured output, and the loop the user owns. Phase 1 ships one;
the rest are captured for later.

### A. Agent usability testing (phase 1, flagship)

Give the agent a goal in natural language; it drives a site toward that goal and
returns a structured report: the path it took, where it stalled, confusing labels,
dead ends. The observe/decide/act loop is the recipe, built from `BrowserSession`

- `LanguageModel` + structured output. This is the headline "the loop is yours"
  demo.

The showcase is self-referential: point it at the effect-uai docs with a goal like
"find out how to combine sandboxes with LLMs," and it opens the site, reads,
clicks through the sidebar, and reports how it got there (or where the docs
tripped it up). Dogfooding, safe (our own site), and it doubles as a docs UX
check. A natural fit for the landing page.

### Deferred

- **E. Accessibility / WCAG audit.** Visit key pages, pull the raw a11y tree + a
  screenshot, LLM flags missing alt text, unlabeled inputs, contrast issues, and
  returns a structured issue list. Composes `BrowserSession` (a11y tree +
  screenshot) + vision LLM + structured output.
- **Visual render check (vision).** Screenshot the rendered effect-uai landing
  page, clipped to the hero's bounding box, and pipe it into a vision model with a
  spec: a checklist of expected elements (logo, tagline, two CTA buttons, no
  overlapping or cut-off text). The model returns a structured verdict
  `{ passed, missing, issues }`, a visual-regression / render smoke test. This
  needs a real browser (it checks the post-CSS/JS rendered pixels, not the DOM),
  dogfoods the site alongside recipe A, and demonstrates a judge/verdict pattern
  rather than the agent loop. Optional flourish: run it against a deliberately
  broken variant to show it catches the regression. Alternative framing if a
  pure "read the pixels" showcase is wanted instead: screenshot a chart on a
  public page (e.g. the Keeling Curve article) and have the model read its trend,
  though there the browser earns less since the figure is a static image.

## 9. Recommendation and phase 1 scope

Proceed with a scoped `BrowserSession` (Layer A, section 7) plus recipe A. The
read-only path (a browser-backed `WebRead` provider) stays available as a
by-product of the same CDP session, but the flagship is the action surface + the
usability-testing recipe.

**Phase 1 providers** (defer all others: Steel, Hyperbrowser, Anchor, Kernel,
Cloudflare, AWS, the scraping vendors):

- **Browserbase**, the reference hosted provider: per-hour CDP sessions, stealth,
  the mainstream "just works in the cloud" story.
- **Browser Use**, raw CDP over a plain `wss://...?apiKey=` URL, the simplest
  hosted handshake; agent-focused.
- **obscura**, local, no-Chrome (Rust/V8, partial CDP), built-in stealth; the
  zero-cloud option.
- **Playwright (local)**, launch a local Chromium; the baseline any dev can run
  with no account.

**Dependency footprint.** The CDP client (`playwright-core` for v1, or a raw-CDP
transport later) lives only in the browser provider package(s), never in
`@effect-uai/core`, declared as an optional peer dependency, the same pattern the
realtime providers use for `ws` (`peerDependencies` + `peerDependenciesMeta.optional`,
see `packages/providers/{openai,mistral,inworld}`). It is pulled in only when a
consumer uses a browser provider. Local providers (Playwright, obscura)
additionally need a browser/engine binary on the machine; remote providers
(Browserbase, Browser Use) connect over CDP with no local browser.

## 10. Open questions

- **Transport for v1:** `playwright-core` (fast, ergonomic actionability, no
  browser download for remote-connect) vs a hand-rolled raw-CDP client on the
  existing `Socket` infra (no dep, but reimplements selector actionability). Lean
  `playwright-core` first, raw-CDP as a later optimization.
- **obscura CDP coverage:** confirm its partial CDP server implements the domains
  recipe A needs (Input for click/type/scroll, Page for navigation/screenshot, DOM
  for selectors) before committing it to phase 1. Perf numbers are self-reported.
- **Browser Use handshake:** confirm the raw `wss://...?apiKey=` CDP flow and
  reconcile the hourly rate (public $0.02/hr vs docs $0.06/hr) before documenting.
- **Local Playwright browser management:** expect a user-provided Chrome vs manage
  the binary; decide how the local provider acquires a browser.
- The read-only `WebRead` browser provider: ship it alongside phase 1 (same
  session, exposed read-only) or defer until asked.

## Sources

Hosted providers: docs.browserbase.com, steel.dev, hyperbrowser.ai,
anchorbrowser.io, browser-use.com, onkernel.com, Cloudflare Browser Rendering
docs, AWS Bedrock AgentCore Browser Tool docs. Local/OSS:
github.com/h4ckf0r0day/obscura, github.com/browser-use/browser-use (+
browser-use.com/posts/playwright-to-cdp), github.com/browserbase/stagehand,
microsoft/playwright-mcp, ChromeDevTools/chrome-devtools-mcp,
vercel-labs/agent-browser. Use cases / market: Browserbase agents docs, Skyvern
travel-booking, Firecrawl best-browser-agents, OpenAI Operator deprecation,
Google Mariner shutdown coverage, Cloudflare AI-bot blocking, 2026 CAPTCHA/
anti-bot fallback analyses.

## 11. Implementation log (build session)

Notes from the build session that started implementing `@effect-uai/browser`
against a hand-started obscura. This resolves several of the section 10 open
questions and records where the code currently stands.

### 11.1 Decisions since section 10

- **Transport: hand-rolled raw CDP over Effect's `Socket`, typed with
  `devtools-protocol`.** Section 10 leaned `playwright-core`; that reversed after
  researching the CDP-client landscape. Findings:
  - There is no official, lean, standalone CDP *client*. ChromeDevTools ships only
    the protocol *types* (`devtools-protocol`, zero runtime, published daily).
  - `playwright-core` (0 deps but 12.7 MB) routes `connectOverCDP` through an
    in-process Node relay (double RPC, added latency) and, decisively, assumes a
    full Chrome CDP surface: it drives `Target.setAutoAttach` / target management
    on connect and is documented to hang or error against partial CDP servers.
    obscura is a partial CDP server, so this is a direct liability.
  - `puppeteer-core` is single-hop and can drop to raw `CDPSession`, but is heavier
    (~23 MB, 6 deps incl. `chromium-bidi`) and still Chrome-family.
  - `chrome-remote-interface` is the only ready-made lean client, but is CJS-only,
    in maintenance mode (~1 release/yr), types lag via `@types/*`, and it owns its
    own socket (we would lose the Effect `Socket` fiber integration).
  - The modern convention, and specifically what Stagehand v3 ships after dropping
    Playwright, is exactly our path: a thin transport plus `devtools-protocol`
    types. Its runtime deps are just `devtools-protocol` + `ws`. browser-use did
    the same in Python (codegen from the official schema).
  - Conclusion: the raw-CDP direction is validated. The one upgrade over the first
    draft is typing `send` against `devtools-protocol` so it is
    `send("Page.navigate", params)` with real param/return types instead of
    stringly-typed records.

- **No `ws` dependency: use the runtime's native `WebSocket`.** Unlike the mistral
  realtime provider (which needs `ws` because it sets auth headers on the socket,
  which the `WebSocket` API cannot do), CDP connect uses a bare `ws://` URL with no
  custom headers (remote vendors put auth in the URL or a query param). So the
  transport provides `Socket.layerWebSocketConstructorGlobal` (native
  `globalThis.WebSocket`), which works on Bun, Deno, browsers, and Node 22+ (the
  current LTS) with zero dependencies. `ws` is not imported at all; it is only a
  potential old-Node escape hatch, deferred. This makes the earlier "optional peer
  `ws`" question moot: the browser package has no socket dependency to declare.

- **`devtools-protocol` pinned as a type-only devDependency** (`0.0.1651496`; a
  version older than the repo's one-week release-age gate). Types only, erased at
  build, so no runtime cost and it stays out of the public `.d.mts` surface (the
  `Cdp` type is internal).

### 11.2 Where we stand

Created and accepted:

- `packages/providers/browser/src/internal/cdp.ts`. The raw CDP client:
  `openCdp(endpoint): Effect<Cdp, BrowserError, Scope>`. Command/response with id
  correlation via a `HashMap` of pending `Deferred`s, `Schema`-decoded envelope,
  `JSONL.parseSafe`, a scoped reader fiber that fails all pending on close, and a
  `devtools-protocol`-typed `send<M>(method, params?, sessionId?)`. Native
  WebSocket via `layerWebSocketConstructorGlobal`. Events are drained for now
  (navigation and element waits poll through `Runtime.evaluate`).
- Package scaffolding: `package.json` (name `@effect-uai/browser`, v0.9.0 to match
  the fixed group, no `ws`), `tsconfig.json`, `tsdown.config.ts`. Added to the
  `.changeset/config.json` fixed group.

Pending (not yet written / accepted):

- `internal/session.ts`: the `BrowserSession` builder over one attached target.
  Implements the verbs, an `ensureLive` expiry guard, and a `waitUntil` polling
  helper for navigation / element waits. Draft was paused on the verb-mechanism
  question below.
- `Connect.ts`: the generic `connect({ endpoint })` layer. `create` opens a scoped
  CDP connection, `Target.createTarget` then `Target.attachToTarget({ flatten:
  true })`, enables `Page` / `Runtime` / `Network`, registers a `Target.closeTarget`
  finalizer, and registers both the provider tag and the core `Browser` tag via
  `Layer.mergeAll`. Plus `attach` / `list` / `destroy`.
- `index.ts`, then `pnpm install` + `oxfmt` + `typecheck`, then an end-to-end run
  (connect, goto, content) against a hand-started obscura (needs the user to start
  obscura).

### 11.3 Open question raised mid-build: why hand-written JS in the verbs?

The paused `session.ts` draft implemented every verb by shipping a JS snippet to
`Runtime.evaluate` (a markdown serializer, a `querySelectorAll` mapper, and
per-action snippets like `el.click()` / `dispatchEvent` / `el.value = ...`). The
question was why we hand-write these JS functions at all.

The reasoning, and the honest split:

- **The portability argument (for keeping them).** `Runtime.evaluate` is the
  lowest-common-denominator CDP method: it runs on any V8-backed endpoint,
  including a partial CDP server like obscura. The richer domains that would
  replace these snippets (`DOM.*`, `Input.*`) are exactly the surface a partial
  server may not implement, and are why playwright-core / puppeteer-core break
  against obscura. So injected JS is the mechanism most likely to actually work
  against the first target.
- **But the argument is only strong for some snippets:**

  | Snippet | Native CDP alternative | Verdict |
  | --- | --- | --- |
  | click / hover / press / type (`dispatchEvent`, `el.value=`) | `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` at element coordinates | Weakest part. Synthetic events are `isTrusted: false` and some sites ignore them; `el.value=` bypasses real keystrokes. The Input domain sends real trusted input, at the cost of an extra box lookup and needing the target to implement `Input`. |
  | content (html) | `DOM.getDocument` + `DOM.getOuterHTML` | Native is marginally cleaner, only if `DOM` is implemented. |
  | content (markdown) | none exists | CDP has no markdown primitive. A serializer must live somewhere: injected JS, or fetch outerHTML and convert host-side in TS. |
  | query (querySelectorAll to JSON) | `DOM.querySelectorAll` + `getAttributes` + `getBoxModel` | Injected JS is one round-trip; the DOM domain is several per element. Playwright itself injects JS to query, so this is legitimate. |
  | waitFor / readyState (polling) | `Page.loadEventFired` / lifecycle events | Events are cleaner than polling but need the event demux we deferred in `cdp.ts`. |

- **The tension:** native domains are more faithful (trusted input, real DOM) but
  assume a fuller CDP surface, which is the exact risk against obscura. Injected JS
  is portable but interactions are synthetic. Three ways to lean were put to the
  user: (a) injected JS now for everything (fastest to an obscura demo, add an
  `Input`-domain path later); (b) hybrid, `Input` domain for actions + injected JS
  for query and markdown; (c) native domains everywhere, injected JS only for the
  markdown serializer. Decision pending.
