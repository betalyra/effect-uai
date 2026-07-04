# Local / open-source browser automation for AI agents (2025-2026)

Raw research report.

## The two-layer split (confirmed)

The central organizing fact of this landscape:

- **Layer A, the transport / "control a browser":** CDP (Chrome DevTools
  Protocol) over WebSocket, optionally wrapped by Playwright or Puppeteer. This
  is a _driver_. Uniform, provider-agnostic, and the same call surface whether
  the browser is launched locally or lives in a cloud (Browserbase, Browserless,
  Cloudflare, AgentCore).
- **Layer B, the agent loop / "LLM decides what to click":** snapshot the page
  into something an LLM can ground on (accessibility tree + element refs, or
  set-of-marks + vision), let the model pick an action, execute it via Layer A,
  repeat. This is `browser-use`, Stagehand, Skyvern, and every MCP server.

The refinement worth adding: there is a **Layer A', an "agent-shaped read
model"** that sits just above raw CDP but below the LLM loop: `browser_snapshot`
returning an ARIA tree with stable `@e1`/`ref` identifiers. Playwright-MCP,
Chrome-DevTools-MCP, obscura's MCP, and agent-browser all converge on the _exact
same primitive_ (snapshot, ref, click/fill by ref). This is the genuinely
reusable agent-specific piece; the LLM-decides loop above it is application
composition.

## CDP-over-WebSocket as universal substrate (confirmed, with one caveat)

Yes. `chromium.connectOverCDP({ endpointURL: 'ws://.../devtools/browser/<id>' })`
is the shared entry point for local and remote. Browserbase's flow is: POST to
`api.browserbase.com/v1/sessions`, get a session `connectUrl` (a WebSocket),
`connectOverCDP(connectUrl)`. Cloudflare Browser Rendering, Browserless, and
obscura all expose the same `ws://...:9222` shape. So a single effect-uai service
abstraction over "a CDP WebSocket endpoint" transparently covers launch-local and
connect-remote.

Caveat #1, Playwright vs raw CDP: `connectOverCDP` still routes through a Node
Playwright relay server, adding a second network hop. `browser-use` publicly
**left Playwright for raw CDP** citing per-call latency across thousands of CDP
calls, hang-on-reply state drift between browser/Node-relay/client, and
incomplete edge-case coverage (cross-origin iframes, crashes, remote file ops).
For a high-throughput agent, raw CDP beats the Playwright wrapper; for
ergonomics, Playwright wins. Both still terminate in the same CDP-over-WS pipe.

Caveat #2, BiDi is emerging under CDP. Puppeteer 24+ defaults to **WebDriver
BiDi** (a W3C-standard bidirectional WS protocol) for cross-browser (Firefox),
while keeping CDP as default/available for Chrome. CDP remains the Chrome
substrate; BiDi is the cross-browser future but not yet the universal substrate
for agent stealth work (stealth patches target CDP specifics).

## Per-tool breakdown

### Drivers / transports (Layer A)

**Playwright**, automation _library_ (not just testing). Drives Chromium via CDP;
Firefox/WebKit via its own protocols; BiDi increasingly. `connectOverCDP`
connects to any external Chrome exposing a CDP WS (local
`--remote-debugging-port=9222` or remote cloud). TS/Node first-class (also
Python/Java/.NET). Agent features: none intrinsic, but exposes
`page.accessibility.snapshot()` which the agent layer builds on.

**Puppeteer**, Google's Node/TS automation library. CDP-native for Chrome; BiDi
default from v24 for cross-browser. Slightly lower-level than Playwright. TS/Node
only (no first-party Python). No agent features; it's the base that stealth
patches modify.

**obscura** (`h4ckf0r0day/obscura`), _the standout for effect-uai's purposes._ A
from-scratch headless browser engine written in **Rust that embeds V8** (no
Chrome, no Node dependency). It implements a **partial CDP server** (Target,
Page, Runtime, DOM, Network, Fetch, Storage, Input domains) and is a **CDP
drop-in**: Playwright/Puppeteer connect via `connectOverCDP({ endpointURL:
'ws://127.0.0.1:9222' })`. Selling points: ~30 MB RAM vs 200+, 70 MB binary,
~85 ms loads, instant start. "Designed for agent use" means two things
concretely: (1) built-in **stealth** (per-session fingerprint randomization of
GPU/screen/canvas/audio/battery, `navigator.webdriver=undefined`,
`event.isTrusted=true`, native-function masking, realistic `userAgentData`
Chrome 145, 3,520 tracker domains blocked); (2) a **bundled MCP server**
(`obscura mcp`, stdio or `--http`) exposing 13 tools including `browser_snapshot`,
`browser_click`, `browser_fill`, `browser_evaluate`, plus a `LP.getMarkdown` CDP
method for DOM to Markdown. It does **not** implement accessibility-tree
set-of-marks/vision itself. Runtime: Rust binary, language-agnostic client (any
CDP client). Interface: it's a _drop-in remote-CDP endpoint_, so it slots under a
Playwright/CDP effect-uai service exactly like Browserbase does. Limitation:
partial CDP coverage; not a full Chrome equivalent. _Note: obscura's own claims
are self-reported in its README; independent benchmarks unverified._

### Anti-detection layers (patch Layer A)

**puppeteer-extra-plugin-stealth**, runtime JS monkey-patches applied inside the
page to hide automation tells. Node/TS. Status: effectively **stale** (v2.11.2,
~3 yrs no update) and widely considered insufficient vs modern
Cloudflare/DataDome. Does not fix the CDP-level `Runtime.enable` leak.

**rebrowser-patches** (`rebrowser/rebrowser-patches`), the **modern approach**.
Patches Puppeteer/Playwright **source in `node_modules`** (not runtime JS) to fix
the **`Runtime.enable` CDP leak**, the tell that anti-bots (Cloudflare, DataDome)
use to detect automation via the `Runtime.consoleAPICalled` behavior. Modes:
`addBinding` (default), `alwaysIsolated`, `enableDisable`. Node/TS. Because the
leak is at the CDP protocol level, patching there is more fundamental than
page-level stealth JS. Relevant only if driving via patched Puppeteer/Playwright;
obscura addresses the same class of problem inside its own engine.

**nodriver** (`ultrafunkamsterdam/nodriver`), official successor to
undetected-chromedriver. **Python**, async, talks **direct CDP** with _no
chromedriver binary and no Selenium_ (that removal is itself the stealth win).
Fresh profile per run; `tab.cf_verify()` for Cloudflare. No Node/TS equivalent.
Not directly usable from Node, but its architecture (direct-CDP, no webdriver) is
the pattern obscura/agent-browser also follow.

### Agent libraries (Layer B, the LLM loop)

**browser-use** (`browser-use/browser-use`), the reference Python agent-browser
library. Python >=3.11; recently rearchitected as Python API, Rust core, raw CDP
browser harness (moved off Playwright, see caveat above). Grounding: indexed
clickable elements (set-of-marks style) + DOM state + optional vision/screenshots;
LLM receives the indexed element list and emits actions. Multi-provider
(OpenAI/Anthropic/Google + their own model). **No official TS/Node port**, only
community ports (`browser-use-node`, `browser-use-typescript`),
unmaintained/unofficial. For an Effect-TS library this is a _design reference, not
a dependency_.

**Stagehand** (`browserbase/stagehand`), Browserbase's open-source agent lib.
**TypeScript/Node is first-class** (separate Python impl exists). Uses a **CDP
engine** directly ("optimized low-level interface built for automation"), runs
local _and_ remote-Browserbase. High-level verbs: **`act()`** (single action),
**`observe()`** (preview/plan actions before running), **`extract()`** (structured
data via schema), **`agent()`** (multi-step). Adds **self-healing / action
caching** (remembers prior actions, re-heals selectors) and a code-vs-NL escape
hatch. This is the closest existing thing to "the agent loop you'd otherwise
build", and the strongest candidate to _wrap or take inspiration from_ rather
than reimplement, since it's already TS.

**Skyvern** (`Skyvern-AI/skyvern`), Python (Playwright-compatible SDK adding AI on
top of Playwright; also CDP-connect to existing Chrome). **Vision-LLM-first**: a
swarm of agents comprehends pages visually rather than via selectors, resilient
to layout changes. Self-hostable (pip/Docker) with API+UI, or cloud. Has a
**TypeScript client** (`@skyvern/client`) for the API, but the engine is Python.
Effectively a _service you call_, not an in-process TS library.

### MCP servers (Layer B exposed as tools)

**Microsoft Playwright MCP** (`microsoft/playwright-mcp`), Node/TS MCP server over
Playwright (CDP). **Accessibility-tree-first, no vision**: `browser_snapshot`
returns an ARIA tree; actions reference elements by snapshot **ref**
(deterministic, no pixel coords). Tools:
`browser_navigate/click/type/fill_form/select_option/snapshot/evaluate/wait_for`

- optional vision, network mocking, tracing. This is the canonical "snapshot +
  ref" pattern.

**Chrome DevTools MCP** (`ChromeDevTools/chrome-devtools-mcp`), official Chrome
team MCP server, **driven via Puppeteer**, ~50+ tools skewed toward
**debugging/perf** (performance traces, network inspection, heap snapshots,
console with source-mapped stacks) plus input automation. Node/TS. Less about
LLM-grounding snapshots, more about giving a coding agent full DevTools power.

**agent-browser** (`vercel-labs/agent-browser`), "give an agent a browser as a
tool" framework. Two sources disagree: the repo fetch describes a **Rust daemon +
TypeScript bindings** driving Chrome (Chrome-for-Testing) over **direct CDP**,
persisting between commands; a secondary source framed it as TS-centric. Either
way: same **snapshot, `@e1` ref, click/fill** grounding pattern, `--json` machine
output, and **explicit local + remote support** (Browserbase, Browserless,
Browser Use, AgentCore via env/flags). _Runtime detail (Rust core vs pure TS)
unverified, confirm before depending._

## Recommendation for an effect-uai provider abstraction

- **Unify Layer A (the CDP transport).** The right effect-uai provider surface is
  _"a browser session backed by a CDP WebSocket endpoint,"_ with implementations
  for: launch-local-Chromium, connect-remote (Browserbase/Cloudflare/Browserless),
  and connect-obscura. This is genuinely uniform across every provider above and
  matches the "one API surface per protocol" instinct, the protocol here is
  **CDP**, not any vendor. Optionally expose a raw-CDP vs Playwright-wrapper
  toggle (the browser-use lesson).
- **Standardize Layer A' as a shared capability, not per-provider.** The
  `snapshot, ref, act(ref)` accessibility-tree primitive is identical across
  Playwright-MCP / agent-browser / obscura and is the reusable agent-grounding
  piece worth a core tag.
- **Do NOT make Layer B (the act/observe/extract LLM loop) a provider
  abstraction.** That loop is application-level composition, exactly the shape of
  the existing agent-loop recipes (stream turn, run tool, continue).
  Stagehand/browser-use/Skyvern are _reference designs_ for that loop, not things
  to abstract behind a provider interface. Model "the browser" as a **tool the
  agent loop calls**, where the tool is backed by the Layer A CDP service.
- **TS/Node reality check:** first-class TS = Playwright, Puppeteer, Stagehand,
  Playwright-MCP, Chrome-DevTools-MCP, rebrowser-patches, obscura (as a CDP
  endpoint, language-agnostic). Python-only (reference only) = browser-use,
  Skyvern, nodriver. So an Effect-TS library can build the whole stack natively on
  **CDP + Playwright/Puppeteer + obscura**, borrowing agent-loop _ideas_ from the
  Python tools without depending on them.

## Sources

[obscura](https://github.com/h4ckf0r0day/obscura),
[browser-use](https://github.com/browser-use/browser-use) &
[Playwright to CDP post](https://browser-use.com/posts/playwright-to-cdp),
[Stagehand](https://github.com/browserbase/stagehand),
[Playwright MCP](https://github.com/microsoft/playwright-mcp),
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp),
[rebrowser-patches](https://github.com/rebrowser/rebrowser-patches),
[nodriver](https://github.com/ultrafunkamsterdam/nodriver),
[Skyvern](https://github.com/Skyvern-AI/skyvern),
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser),
[Puppeteer WebDriver BiDi](https://pptr.dev/webdriver-bidi),
[Browserbase Playwright docs](https://docs.browserbase.com/introduction/playwright).

**Unverified / flagged:** obscura's perf numbers (self-reported); agent-browser's
exact runtime (Rust-core-with-TS-bindings vs pure TS), sources conflict;
browser-use TS ports are unofficial/community.
