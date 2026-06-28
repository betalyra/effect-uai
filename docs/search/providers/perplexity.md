---
title: Perplexity
description: "Perplexity's Search API as a WebSearch backend: fast, current-events snippets with a search-context-size depth knob."
---

[Perplexity](https://docs.perplexity.ai/) is the quickest way to put fresh
web snippets in front of a model. Its `/search` endpoint returns ranked
links with short excerpts, and a single `searchContextSize` knob decides how
many pages it reads per query, so you can dial in the latency you can afford.

Note this is the raw `/search` endpoint, not Perplexity's Sonar answer
engine: effect-uai hands you the results and lets you pick the model that
reads them. See [Web search](/search/) for why that split matters.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/perplexity effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as perplexityLayer } from "@effect-uai/perplexity/PerplexitySearch"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("PERPLEXITY_API_KEY")
    return perplexityLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`perplexityLayer` registers two service tags from one implementation:

- **`PerplexitySearch`**: the typed tag. Yield this for the
  Perplexity-specific knobs below.
- **`WebSearch`**: the generic tag for provider-portable code, including
  [`webSearchTool`](/search/#drop-it-into-an-llm).

## Calling it

```ts
import { PerplexitySearch } from "@effect-uai/perplexity/PerplexitySearch"

const program = Effect.gen(function* () {
  const search = yield* PerplexitySearch
  return search.search({
    query: "effect-ts v4 release notes",
    maxResults: 5,
    recency: "week",
    searchContextSize: "high", // low | medium | high: depth vs latency
  })
})
```

Every cross-provider field from [`CommonSearchRequest`](/search/#what-you-ask-for)
(`maxResults`, `includeDomains`, `recency`, `country`, …) works here. The
typed request adds:

| Field               | Values                | Meaning                                  |
| ------------------- | --------------------- | ---------------------------------------- |
| `searchContextSize` | `low` `medium` `high` | Pages fetched per query. `high` default. |
| `maxTokensPerPage`  | `number`              | Cap on text pulled from each page.       |

Perplexity returns a `snippet` on each result; it does not rank with a
`score`. Anything not promoted to the common
[`SearchResult`](/search/#what-you-get-back) shape stays on `raw`.

## See also

- [Web search](/search/): the cross-provider concept and the portable
  request / result shapes.
- [Grounded answer](/recipes/grounded-answer/): a streaming agent that
  answers from live search with citations.
