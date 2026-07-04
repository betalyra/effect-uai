---
title: Browser
description: "A live browser session your agent can drive: navigate, click, fill, read the page as markdown, and pull typed element info, with disposal tied to an Effect Scope."
---

Sooner or later an agent needs to touch the web the way a person does: open a
page, click through a flow, fill a form, read what came back. A `Browser`
session is a live browser you can do that against, with the same
scope-bound lifecycle as the rest of effect-uai.

## Quickstart

Wire up a provider, create a session, drive a page:

```ts
import { Effect } from "effect"
import * as Browser from "@effect-uai/core/Browser"
import { layer as cdpLayer } from "@effect-uai/browser/Connect"

const program = Effect.gen(function* () {
  const session = yield* Browser.create({ timeout: "2 minutes" })
  yield* session.goto("https://example.com")

  const markdown = yield* session.content("markdown")
  yield* Effect.log(markdown)

  yield* session.click("a")
})

await Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(cdpLayer({ endpoint: "ws://127.0.0.1:9222/devtools/browser" })),
  ),
)
```

That is the whole story: provide a provider layer, `create` a session, drive
it with verbs, let the scope close and the session is disposed automatically.

## Create and destroy

You don't call `dispose()` on a session. It doesn't exist as a method.
Disposal is tied to an Effect `Scope`:

```ts
Effect.gen(function* () {
  const session = yield* Browser.create({ timeout: "2 minutes" })
  // … drive session …
}).pipe(Effect.scoped) // ← session is disposed here
```

Three idioms cover almost everything:

- **`Effect.scoped`**: dispose when this Effect finishes. The common case.
- **`Scope.make` + manual close**: when one session should span many calls
  inside a larger program; close the scope when you're done.
- **`Browser.destroy(id)`**: escape hatch when you need to kill a session from
  another fiber (or from outside its owning scope).

Two knobs bound a session's lifetime independent of the scope:

- **`timeout`**: hard max lifetime. When it elapses the handle is disposed and
  further calls fail with `BrowserSessionExpired`.
- **`idleTimeout`**: dispose after this much inactivity, the timer resetting on
  each operation. Opt-in; omit for no idle limit.

## The verbs

A session handle is a flat bag of `Effect` values. Every action takes a CSS
selector string, so `#id` is just `#id`, and every one fails with a
`BrowserError`.

**Navigate and wait.** `goto(url)`, `waitFor(selector)` (resolves when the
element appears, backed by a page-side observer, not a poll loop).

**Interact.** `click`, `dblclick`, `fill(selector, text)`, `type`, `press(key)`,
`hover`, `focus`, `select(selector, value)`, `check`, `uncheck`,
`scroll({ direction, pixels? })`, `scrollIntoView`.

**Observe.** `content("markdown" | "html")` renders the live page to text;
`query(selector)` returns an array of `ElementInfo` (tag, text, attributes,
box, and a `ref`); `screenshot(options?)` returns PNG bytes; `snapshot`
returns the accessibility tree as an `AxNode`.

**State and escape hatch.** `cookies.get` / `cookies.set` for authenticated
flows, and `evaluate(script)` for anything no verb covers.

## Refs and selectors

`query` returns serializable `ElementInfo`, not a live element handle (handles
go stale across navigation and don't cross a provider boundary cleanly). Each
carries a `ref` string usable as a selector for the next action:

```ts
const buttons = yield* session.query("button")
const submit = buttons.find((b) => b.text?.includes("Add to cart"))
if (submit) yield* session.click(submit.ref)
```

A `ref` (and any `AxNode.ref` from `snapshot`) is valid until the next
navigation. Don't cache one across a `goto` or a page-changing click.

## Text, not pixels

For agent grounding, prefer `content("markdown")` plus `query(...)` over
`screenshot`. Markdown captures the whole page (not just the viewport) and
feeds straight into a model; a numbered element list gives the model
selectors to act on. Vision-free grounding is also the most portable: it
needs nothing beyond the base CDP surface.

`snapshot` (the accessibility tree) is richer but needs the provider's
Accessibility domain. Against a partial engine that doesn't ship it, `snapshot`
fails with `BrowserUnsupported` while `content` and `query` keep working.
`screenshot` likewise depends on provider capture support.

## What `Browser` is not

- **Not a scraper framework.** No crawl queue, no dedup, no rate-limit
  policy. One session, one handle. Build the crawl on top.
- **Not a test runner.** No assertions, no fixtures, no reporters. The verbs
  are the primitive; the [usability recipe](/recipes/browser-usability/) shows
  a loop composed from them.
- **Not tied to one engine.** The generic tag is provider-portable; anything
  engine-specific lives behind `evaluate` or the typed provider tag.

## Next step

Wire up an adapter:

- **[Generic CDP](/browser/providers/cdp/)**: point it at any Chrome DevTools
  Protocol WebSocket endpoint, a local Chromium (`--remote-debugging-port`),
  [obscura](https://github.com/h4ckf0r0day/obscura), or a hosted CDP vendor.
