---
title: Exa Contents
description: "Exa's /contents endpoint as a WebRead backend: fetch a URL as clean markdown or HTML, with a cache-freshness knob and length cap."
---

[Exa](https://docs.exa.ai/) reads a URL through its `/contents` endpoint and
returns the page as clean markdown, or as HTML when you ask for it. It shares
the `@effect-uai/exa` package with [Exa search](/search/providers/exa/), so
the same key powers both.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/exa effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as exaLayer } from "@effect-uai/exa/ExaContents"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("EXA_API_KEY")
    return exaLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`exaLayer` registers two service tags from one implementation:

- **`ExaContents`**: the typed tag. Yield this for the knobs below.
- **`WebRead`**: the generic tag for provider-portable code.

## Calling it

```ts
import { ExaContents } from "@effect-uai/exa/ExaContents"

const program = Effect.gen(function* () {
  const reader = yield* ExaContents
  return reader.read({
    url: "https://effect.website/docs",
    format: "markdown",
    maxCharacters: 8000,
  })
})
```

Every field from [`CommonReadRequest`](/web-reading/#what-you-ask-for) works
here. The typed request adds:

| Field           | Type                                   | Meaning                                |
| --------------- | -------------------------------------- | -------------------------------------- |
| `livecrawl`     | `never` `fallback` `preferred` `always` | Fetch live vs serve from Exa's cache.  |
| `maxCharacters` | `number`                               | Cap the returned content length.       |

## See also

- [Web reading](/web-reading/): the cross-provider concept and the portable
  request / response shapes.
- [Exa search](/search/providers/exa/): the other capability on this package.
