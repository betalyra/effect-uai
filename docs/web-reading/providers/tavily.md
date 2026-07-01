---
title: Tavily Extract
description: "Tavily's /extract endpoint as a WebRead backend: fetch a URL as clean markdown, with a depth knob for heavier pages."
---

[Tavily](https://docs.tavily.com/) reads a URL through its `/extract` endpoint
and returns the page as clean markdown. It shares the `@effect-uai/tavily`
package with [Tavily search](/search/providers/tavily/).

Tavily produces markdown or plain text only, no HTML. A `format: "html"`
request is honored by falling back to markdown with a dropped-capability
warning, rather than failing. this is the standard bucket-2 behavior described
in [what you ask for](/web-reading/#what-you-ask-for).

## Install

```sh
pnpm add @effect-uai/core @effect-uai/tavily effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as tavilyLayer } from "@effect-uai/tavily/TavilyRead"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("TAVILY_API_KEY")
    return tavilyLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`tavilyLayer` registers two service tags from one implementation:

- **`TavilyRead`**: the typed tag. Yield this for the depth knob below.
- **`WebRead`**: the generic tag for provider-portable code.

## Calling it

```ts
import { TavilyRead } from "@effect-uai/tavily/TavilyRead"

const program = Effect.gen(function* () {
  const reader = yield* TavilyRead
  return reader.read({
    url: "https://effect.website/docs",
    extractDepth: "advanced",
  })
})
```

Every field from [`CommonReadRequest`](/web-reading/#what-you-ask-for) works
here. The typed request adds:

| Field          | Type                | Meaning                                       |
| -------------- | ------------------- | --------------------------------------------- |
| `extractDepth` | `basic` `advanced`  | `advanced` pulls more (tables, embeds) at 2x cost. |

## See also

- [Web reading](/web-reading/): the cross-provider concept and the portable
  request / response shapes.
- [Tavily search](/search/providers/tavily/): the other capability on this
  package.
