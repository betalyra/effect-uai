---
title: Generic CDP
description: "Drive any Chrome DevTools Protocol WebSocket endpoint: a local Chromium, obscura's partial CDP server, or a hosted vendor's connect URL."
source: packages/providers/browser
---

The generic CDP provider points at any browser-level [Chrome DevTools
Protocol](https://chromedevtools.github.io/devtools-protocol/) WebSocket
endpoint and registers the core `Browser` capability over it. It is the shared
floor for the whole field: a locally launched Chromium
(`--remote-debugging-port`), [obscura](https://github.com/h4ckf0r0day/obscura)'s
from-scratch partial CDP server, or a hosted vendor's `wss://` connect URL
pasted straight in. Vendor-specific packages (a session-create REST call, an
auth handshake) can layer on top and reuse this data plane.

The client is hand-rolled over Effect's `Socket`. No `playwright`,
`puppeteer`, or `ws` dependency; it speaks CDP directly over the platform's
native WebSocket.

Good fit for: driving a browser you already run (local Chromium, a CDP engine
in a container), portable agent grounding over text. Less good fit for:
provider features that live behind a vendor SDK rather than the CDP wire.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/browser effect
```

## Wire it up

Pass the browser-level CDP WebSocket endpoint:

```ts
import { Effect } from "effect"
import * as Browser from "@effect-uai/core/Browser"
import { layer as cdpLayer } from "@effect-uai/browser/Connect"

const provider = cdpLayer({
  endpoint: "ws://127.0.0.1:9222/devtools/browser",
})

const program = Effect.gen(function* () {
  const session = yield* Browser.create({ timeout: "2 minutes" })
  yield* session.goto("https://example.com")
  return yield* session.content("markdown")
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(provider)))
```

For a local Chromium, the browser-level endpoint (with its `<uuid>` path) comes
from `http://127.0.0.1:9222/json/version`:

```sh
chromium --headless --remote-debugging-port=9222
curl -s http://127.0.0.1:9222/json/version # → "webSocketDebuggerUrl"
```

`cdpLayer` registers two service tags from one implementation:

- **`CdpBrowser`**: the typed tag for this provider.
- **`Browser`**: the generic, provider-portable tag. Yield this for code that
  should work across browser backends.

## Sessions map to CDP targets

- **`create`** opens a fresh target (tab) and attaches to it.
- **`attach(id)`** re-attaches to an existing target by id; the finalizer
  detaches without closing, for a session kept warm across runs.
- **`destroy(id)`** closes the target from anywhere.

A plain CDP endpoint has no server-side session cap, so the `timeout` and
`idleTimeout` knobs on the create request are enforced locally by the session's
reaper fibers.

## Running against obscura

[obscura](https://github.com/h4ckf0r0day/obscura) is a from-scratch headless
CDP engine (no Chrome install needed), handy for local development and CI:

```sh
docker run -d --name obscura -p 127.0.0.1:9222:9222 h4ckf0r0day/obscura
# endpoint: ws://127.0.0.1:9222/devtools/browser
```

obscura implements a partial CDP surface. Domain-enable calls it doesn't
recognize are tolerated at connect time, and verbs that need a missing domain
fail cleanly rather than crashing the session. In practice `snapshot` (needs
the Accessibility domain) returns `BrowserUnsupported`, while `goto`, `click`,
`fill`, `content`, and `query` all work. That is exactly the vision-free
surface the [usability recipe](/recipes/browser-usability/) is built on.

## Next step

- **[Agent usability testing](/recipes/browser-usability/)**: an observe /
  decide / act loop that drives this provider toward a plain-language goal and
  reports the UX friction it hit.
