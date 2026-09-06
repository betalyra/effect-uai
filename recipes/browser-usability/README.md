---
title: Agent usability testing
description: Describe a goal in plain language, point it at your site, and get back a typed report of whether an agent could accomplish it, the path it took, and the UX friction it hit.
source: recipes/browser-usability
icon: PiCursorClick
---

Can people actually finish the flows you built? Finding out normally means
a usability study: put someone in front of the site, give them a task, and
watch where they get stuck. Most teams do this rarely because it takes real
time and real people.

This recipe runs that study with an agent. Describe the task the way you
would brief a tester ("buy two brush pens and reach checkout"), point it at
a URL, and the agent works the site in a real browser until it reaches the
goal or gives up. You get back a typed report: whether the goal was
reachable, every step it took and why, and the friction it hit, like a label
it misread or a search box that never answered. The report is data, so you
can run the same task on every deploy and watch the friction list.

## Try it

Start a headless Chromium with its DevTools port open:

```sh
docker run -d --name chromium -p 127.0.0.1:9222:9222 chromedp/headless-shell
```

The default goal is a real shopping task against
[NextFaster](https://github.com/ethanniser/NextFaster), an open-source
art-supplies demo store: find calligraphy brush pens, add two to the cart,
reach the order page, stop before checkout.

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/browser-usability/run.ts
```

Point it at your own site by overriding the goal and URL:

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/browser-usability/run.ts \
  --goal "Find the pricing page and read the top tier" \
  --url https://exa.ai \
  --max-steps 8
```

Worth trying: ask for something the store does not sell (a kitchen mug in
an art-supplies shop). The agent reports `goalAchieved: false` with friction
explaining why, rather than inventing a product.

## Configuration

| Env var          | Default                              | Meaning                                                                                                     |
| ---------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GOOGLE_API_KEY` | (required)                           | Gemini API key for the decision model.                                                                      |
| `GOAL`           | Shop for calligraphy brush pens (…). | The task you want a first-time user to finish.                                                              |
| `START_URL`      | `https://next-faster.vercel.app`     | Where the agent begins.                                                                                     |
| `MODEL`          | `gemini-3-flash-preview`             | Decision model id.                                                                                          |
| `MAX_STEPS`      | `20`                                 | Hard cap on loop iterations.                                                                                |
| `CDP_URL`        | `http://127.0.0.1:9222`              | Chromium debug address (`http://` is resolved to the `ws://` endpoint automatically) or a full `ws://` URL. |
| `LOG_LEVEL`      | `Info`                               | Set `Debug` to see each step live.                                                                          |

## How it works

The model is handed the browser as a set of tools (navigate, click, fill,
press, scroll, read the page) plus a `finish` tool carrying the report
schema, and decides each turn what to do next. Reading a page returns its
content as markdown with the interactive elements labeled, so the next
action is grounded in what is actually on screen. When an action fails, the
failure is fed back to the model as a tool result instead of ending the
run, and it adjusts course. The run ends when the model files its report or
the step budget forces one.

All of this is a standard tool-calling loop in a few dozen lines of Effect.
The `Browser` provider owns only the wire; the recipe owns everything about
how to test.

- `recipe.ts`: the loop, the `finish` tool, and the trail bookkeeping.
- `app.ts`: composition (Chromium `Browser` Layer, Gemini `LanguageModel`
  Layer), env config, and the report formatter.
- `run.ts`: attaches the Node `HttpClient` and starts the runtime.

`app.ts` drives any CDP endpoint. Point `CDP_URL` at a locally installed
Chrome (`--remote-debugging-port=9222`), a hosted CDP vendor, or even
[obscura](https://github.com/h4ckf0r0day/obscura), a from-scratch partial
CDP engine this recipe's vision-free grounding also runs on. `recipe.ts`
never changes.
