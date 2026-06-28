---
title: Tavily
description: Tavily's Search API as a WebSearch backend — snippets and scores with a search-depth knob and topic filter.
---

[Tavily](https://docs.tavily.com/) is search shaped for agent pipelines:
every result comes back with both an excerpt and a relevance `score`, ready
to drop straight into a prompt. The `searchDepth` knob lets you spend more
credits and latency on the queries that deserve it, and `topic` points the
search at news or finance when you need it.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/tavily effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as tavilyLayer } from "@effect-uai/tavily/TavilySearch"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("TAVILY_API_KEY")
    return tavilyLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`tavilyLayer` registers two service tags from one implementation:

- **`TavilySearch`** — the typed tag. Yield this for the Tavily-specific
  knobs below and the per-result `score`.
- **`WebSearch`** — the generic tag for provider-portable code, including
  [`webSearchTool`](/search/#drop-it-into-an-llm).

## Calling it

```ts
import { TavilySearch } from "@effect-uai/tavily/TavilySearch"

const program = Effect.gen(function* () {
  const search = yield* TavilySearch
  return search.search({
    query: "latest stable node lts",
    maxResults: 5,
    searchDepth: "advanced", // thoroughness vs credits / latency
    topic: "news", // unlocks day-windowed recency
  })
})
```

Every cross-provider field from [`CommonSearchRequest`](/search/#what-you-ask-for)
works here. The typed request adds:

| Field             | Values                                 | Meaning                                                   |
| ----------------- | -------------------------------------- | --------------------------------------------------------- |
| `searchDepth`     | `basic` `advanced` `fast` `ultra-fast` | Thoroughness. `basic`/`fast` cost 1 credit, `advanced` 2. |
| `topic`           | `general` `news` `finance`             | Index vertical. `news` adds per-result dates.             |
| `chunksPerSource` | `number`                               | How much content each source contributes.                 |

Tavily fills both `snippet` and `score`. Tavily has no language filter, so
passing `language` warns rather than failing the call. Anything not promoted
to the common [`SearchResult`](/search/#what-you-get-back) shape stays on
`raw`.

## See also

- [Web search](/search/) — the cross-provider concept and the portable
  request / result shapes.
- [Grounded answer](/recipes/grounded-answer/) — a streaming agent that
  answers from live search with citations.
