---
title: Agent usability testing
description: Describe a goal in plain language, point it at your site, and get back a typed report of whether an agent could accomplish it, the path it took, and every point of UX friction it hit.
source: recipes/browser-usability
icon: PiCursorClick
---

You shipped a checkout flow, a docs site, a signup funnel. Can someone
actually complete it? Finding out usually means a usability study: sit a
stranger in front of the page, give them a task, watch where they stall. Slow,
expensive, hard to run on every change.

This recipe does it automatically. Describe a goal the way you would brief a
tester ("buy two brush pens and reach checkout", "find the top pricing tier"),
point it at a URL, and it drives a real browser toward that goal like a
first-time visitor. You get back a typed report: whether the goal was
reachable, the path it took (every step with the reasoning behind it), and a
list of friction. Confusing labels, dead ends, controls it could not find,
searches that never responded.

That friction list is the product. Same feedback a human tester would give,
generated on demand against any URL, cheap enough for CI.

## Try it

Start [obscura](https://github.com/h4ckf0r0day/obscura), a from-scratch
headless browser engine (no Chrome needed):

```sh
docker run -d --name obscura -p 127.0.0.1:9222:9222 h4ckf0r0day/obscura
```

The default goal is a real shopping task against
[NextFaster](https://github.com/ethanniser/NextFaster), an open-source
art-supplies demo store: find calligraphy brush pens, add two to the cart,
reach the order page, stop before checkout.

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/browser-usability/run-node.ts
```

Point it at your own site by overriding the goal and URL:

```sh
GOAL="Find the pricing page and read the top tier" \
  START_URL="https://exa.ai" \
  MAX_STEPS=8 \
  GOOGLE_API_KEY=... pnpm tsx recipes/browser-usability/run-node.ts
```

The default is chosen to show what a real usability test catches: a goal the
site cannot satisfy (a kitchen mug in an art store) returns `goalAchieved=false`
with friction noting the absence instead of inventing a product, and a broken
control (NextFaster's client-rendered search may never respond against a
partial engine) shows up as reported friction while the agent falls back to
browsing. Both are the honest reports a human tester would file.

## Configuration

| Env var           | Default                                | Meaning                                        |
| ----------------- | -------------------------------------- | ---------------------------------------------- |
| `GOOGLE_API_KEY`  | (required)                             | Gemini API key for the decision model.         |
| `GOAL`            | Shop for calligraphy brush pens (…).   | The task you want a first-time user to finish. |
| `START_URL`       | `https://next-faster.vercel.app`       | Where the agent begins.                        |
| `MODEL`           | `gemini-3-flash-preview`               | Decision model id.                             |
| `MAX_STEPS`       | `20`                                   | Hard cap on loop iterations.                   |
| `OBSCURA_CDP_URL` | `ws://127.0.0.1:9222/devtools/browser` | Browser-level CDP WebSocket endpoint.          |
| `LOG_LEVEL`       | `Info`                                 | Set `Debug` to see each step live.             |

## How it works

The agent steers itself. The model is handed the browser as a set of tools
(navigate, click, fill, press, scroll, read the page) plus a `finish` tool
carrying the report schema, and decides each turn what to do next. Reading a
page returns its content as markdown with the interactive elements labeled,
so the model can ground its next action in what is actually there. A failed
action comes back as information rather than a crash, and the agent adapts
the way a person would. The run ends when the model files its report, or
when the step budget forces one.

The whole policy is a few dozen lines of Effect: a standard tool-calling
loop. The `Browser` provider owns only the wire; the recipe owns everything
about how to test.

- `recipe.ts`: the loop, the `finish` tool, and the trail bookkeeping.
- `app.ts`: composition (obscura `Browser` Layer, Gemini `LanguageModel`
  Layer), env config, and the report formatter.
- `run-node.ts`: attaches the Node `HttpClient` and starts the runtime.

`app.ts` drives any CDP WebSocket endpoint. Point it at a local Chromium
(`--remote-debugging-port=9222`) or a hosted CDP vendor by changing only
`OBSCURA_CDP_URL`. `recipe.ts` never changes.
