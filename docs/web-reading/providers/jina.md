---
title: Jina Reader
description: "Jina Reader as a WebRead backend: any URL turned into clean markdown or HTML over a simple header-driven API, priced by tokens."
---

[Jina Reader](https://jina.ai/reader/) fetches a page and returns it as clean
markdown or HTML. The API is header-driven: the URL is the path and every
option is a request header, so it is the lightest backend to run. Pricing is
pay-as-you-go by token, which suits high-volume reading.

The `@effect-uai/jina` package already ships [Jina
embeddings](/embeddings/providers/jina/); the reader is a second tag on the
same package.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/jina effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as jinaLayer } from "@effect-uai/jina/JinaReader"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("JINA_API_KEY")
    return jinaLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`jinaLayer` registers two service tags from one implementation:

- **`JinaReader`**: the typed tag. Yield this for the Reader headers below.
- **`WebRead`**: the generic tag for provider-portable code.

## Calling it

```ts
import { JinaReader } from "@effect-uai/jina/JinaReader"

const program = Effect.gen(function* () {
  const reader = yield* JinaReader
  return reader.read({
    url: "https://effect.website/docs",
    format: "markdown",
  })
})
```

Every field from [`CommonReadRequest`](/web-reading/#what-you-ask-for) works
here. The typed request adds:

| Field              | Type                    | Meaning                                       |
| ------------------ | ----------------------- | --------------------------------------------- |
| `engine`           | `browser` `curl` `auto` | Fetching engine. `browser` renders JS.        |
| `targetSelector`   | `string`                | CSS selector to extract instead of the page.  |
| `noCache`          | `boolean`               | Bypass Jina's page cache.                     |
| `withLinksSummary` | `boolean`               | Return the page's links on `links`.           |

Links are opt-in (`withLinksSummary`) because they add tokens to the response,
which is what Jina bills on.

## See also

- [Web reading](/web-reading/): the cross-provider concept and the portable
  request / response shapes.
- [Market intel](/recipes/market-intel/): read plus structured extraction,
  runnable against Jina with `READ_PROVIDER=jina`.
