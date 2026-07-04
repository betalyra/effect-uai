---
title: Dashboard briefing
description: Point an agent at a dashboard you check by hand and get back a typed briefing, the trend, the anomalies, the headline numbers. When the chart renders client-side, the dashboard is the only API you have; a vision model reads it exactly like you do.
source: recipes/dashboard-briefing
icon: PiChartLineUp
---

Everyone has dashboards they glance at every morning: analytics, ops, a
vendor's usage page. Often the dashboard is the only API you have. Your SaaS
vendor's usage graphs, a Grafana you can view but whose datasource you can't
query, an analytics share link. The charts exist only after the app renders
them client-side: fetch the page with a reader and you get an empty shell.

This recipe reads the dashboard the way you do. It opens the page in a real
browser, screenshots it, and has a vision model turn the pixels into a typed
briefing:

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

Because the output is a `Schema`, not prose, the briefing is data: pipe it
into Slack, diff it against last week's, alert when `anomalies` is
non-empty. Run it on a schedule and nobody has to remember to look.

## Try it

Start a real headless Chromium with its DevTools port open (a render is
only as good as its renderer, so this recipe wants a real engine rather
than a partial one like obscura):

```sh
docker run -d --name chromium -p 127.0.0.1:9222:9222 chromedp/headless-shell
```

Or use a locally installed Chrome (a non-default profile dir is required
for remote debugging):

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp
```

Then run it. The default target is [Plausible's live public
dashboard](https://plausible.io/plausible.io), real traffic data, shared by
design:

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/dashboard-briefing/run-node.ts
```

Point it at your own dashboard, e.g. a Plausible share link, a public
Grafana, or any URL you can open in a browser:

```sh
DASHBOARD_URL="https://plausible.io/share/yoursite.com?auth=..." \
  GOOGLE_API_KEY=... pnpm tsx recipes/dashboard-briefing/run-node.ts
```

Fetch the default target with a reader and compare: the markdown contains a
page shell and no data at all. The chart exists only after the browser runs
the app and draws it, which is exactly why this composition needs a browser
and a vision model rather than a scraper.

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

No agent loop; this is the judge pattern. Open the page, let it settle,
screenshot the full page, and decode a single vision `LanguageModel` turn
against the `Briefing` schema (period, trend, headline metrics, anomalies,
summary). The schema's field annotations double as the model's
instructions, and the prompt pins it to what is visible: values verbatim,
estimates marked with `~`, no invented numbers.

- `recipe.ts`: the briefing schema and the screenshot-then-decode flow.
- `app.ts`: composition (Chromium `Browser` Layer, Gemini `LanguageModel`
  Layer), env config, and the briefing formatter.
- `run-node.ts`: attaches the Node `HttpClient` and starts the runtime.

Next to [agent usability testing](/recipes/browser-usability/) this is the
other half of the `Browser` story: that recipe acts on pages through a tool
loop; this one reads pixels through a single structured turn.
