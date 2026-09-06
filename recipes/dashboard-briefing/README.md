---
title: Dashboard briefing
description: Point an agent at a dashboard you check by hand and get back a typed briefing with the trend, the anomalies, and the headline numbers. When the chart renders client-side, the dashboard is the only API you have; a vision model reads it the way you would.
source: recipes/dashboard-briefing
icon: PiChartLineUp
---

Some numbers you can only get by looking at a dashboard: a SaaS vendor's
usage graphs with no export, a Grafana you can view but not query, an
analytics share link. The charts are drawn in the browser after the app
loads, so fetching those pages with a reader returns an empty shell.

This recipe reads the dashboard for you. It opens the page in a real
browser, takes a screenshot, and asks a vision model to turn what it sees
into a typed briefing:

```
DASHBOARD BRIEFING - https://plausible.io/plausible.io
Period: Last 30 days  ↑ trending up

  Unique visitors: 128k
  Pageviews: 340k

Worth a look:
  - Jun 24: spike to ~2x the surrounding baseline

Traffic is up over the period with a clear weekday rhythm. The Jun 24 spike
stands out against an otherwise steady trend; worth checking what shipped
or got posted that day.
```

The output is a `Schema`, so the briefing is data rather than prose. You can
post it to Slack, diff it against last week's, or alert when `anomalies` is
non-empty. Put it on a schedule and nobody has to remember to look.

## Try it

Start a headless Chromium with its DevTools port open (screenshots need a
real rendering engine; see the [CDP provider](/browser/providers/cdp/) for
other ways to get one):

```sh
docker run -d --name chromium -p 127.0.0.1:9222:9222 chromedp/headless-shell
```

Then run it. The default target is [Plausible's own public
dashboard](https://plausible.io/plausible.io), live traffic for
plausible.io, public on purpose:

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/dashboard-briefing/run.ts
```

Point it at your own dashboard, e.g. a Plausible share link, a public
Grafana, or any URL you can open in a browser:

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/dashboard-briefing/run.ts \
  --url "https://plausible.io/share/yoursite.com?auth=..."
```

## Configuration

| Env var          | Default                             | Meaning                                                                                                     |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GOOGLE_API_KEY` | (required)                          | Gemini API key for the vision model.                                                                        |
| `DASHBOARD_URL`  | `https://plausible.io/plausible.io` | The dashboard to read.                                                                                      |
| `MODEL`          | `gemini-3-flash-preview`            | Vision-capable model id.                                                                                    |
| `SETTLE`         | `2 seconds`                         | How long to let the page render before the screenshot.                                                      |
| `CDP_URL`        | `http://127.0.0.1:9222`             | Chromium debug address (`http://` is resolved to the `ws://` endpoint automatically) or a full `ws://` URL. |
| `LOG_LEVEL`      | `Info`                              | Set `Debug` for screenshot/turn details.                                                                    |

## How it works

There is no agent loop here. The recipe opens the page, waits a moment for
it to render, screenshots the full page, and decodes one vision
`LanguageModel` turn against the `Briefing` schema (period, trend, headline
metrics, anomalies, summary). The schema's field annotations double as
instructions to the model, and the prompt holds it to what is visible:
values read verbatim, estimates marked with `~`, no invented numbers.

- `recipe.ts`: the briefing schema and the screenshot-then-decode flow.
- `app.ts`: composition (Chromium `Browser` Layer, Gemini `LanguageModel`
  Layer), env config, and the briefing formatter.
- `run.ts`: attaches the Node `HttpClient` and starts the runtime.

Next to [agent usability testing](/recipes/browser-usability/) this is the
other half of the `Browser` story: that recipe acts on pages through a tool
loop; this one reads pixels through a single structured turn.
