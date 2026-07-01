---
title: Firecrawl
description: "Firecrawl as a WebRead backend: JS-rendered pages turned into clean markdown or HTML, with main-content stripping and scrape controls."
---

[Firecrawl](https://docs.firecrawl.dev/) fetches a page, renders its
JavaScript, strips the boilerplate, and returns clean markdown or HTML. It is
the reference `WebRead` backend: every field of the common request maps
directly, and its scrape controls (main-content toggle, tag include/exclude,
render wait, proxy tier) are available on the typed request.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/firecrawl effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as firecrawlLayer } from "@effect-uai/firecrawl/FirecrawlRead"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("FIRECRAWL_API_KEY")
    return firecrawlLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`firecrawlLayer` registers two service tags from one implementation:

- **`FirecrawlRead`**: the typed tag. Yield this for the scrape controls
  below.
- **`WebRead`**: the generic tag for provider-portable code.

## Calling it

```ts
import { FirecrawlRead } from "@effect-uai/firecrawl/FirecrawlRead"

const program = Effect.gen(function* () {
  const reader = yield* FirecrawlRead
  return reader.read({
    url: "https://effect.website/docs",
    onlyMainContent: true, // drop nav/header/footer
    format: "markdown",
  })
})
```

Every field from [`CommonReadRequest`](/web-reading/#what-you-ask-for) works
here. The typed request adds:

| Field             | Type                | Meaning                                       |
| ----------------- | ------------------- | --------------------------------------------- |
| `onlyMainContent` | `boolean`           | Drop nav, header, footer, and sidebar.        |
| `includeTags`     | `string[]`          | Restrict extraction to these tags/selectors.  |
| `excludeTags`     | `string[]`          | Drop these tags/selectors before extraction.  |
| `waitFor`         | `Duration`          | Wait for the page to settle (JS-heavy sites). |
| `mobile`          | `boolean`           | Emulate a mobile device.                      |
| `proxy`           | `basic` `stealth` … | Proxy tier for anti-bot protection.           |

## See also

- [Web reading](/web-reading/): the cross-provider concept and the portable
  request / response shapes.
- [Market intel](/recipes/market-intel/): read plus structured extraction
  over a batch of pages.
