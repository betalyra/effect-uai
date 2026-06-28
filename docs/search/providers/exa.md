---
title: Exa
description: Exa's neural search as a WebSearch backend — semantic retrieval ranked by score, with a retrieval-strategy knob and content-vertical filter.
---

[Exa](https://docs.exa.ai/) searches by meaning rather than keywords. It
ranks the web semantically and scores every result, so it shines on the
queries where the words you would search for are not the words on the page:
"papers arguing against scaling laws" finds the right papers even when none
of them contain that phrase. The `type` knob picks the retrieval strategy
and `category` narrows to a content vertical (news, research papers, people,
and so on).

## Install

```sh
pnpm add @effect-uai/core @effect-uai/exa effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as exaLayer } from "@effect-uai/exa/ExaSearch"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("EXA_API_KEY")
    return exaLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

`exaLayer` registers two service tags from one implementation:

- **`ExaSearch`** — the typed tag. Yield this for the Exa-specific knobs
  below and the per-result `score`.
- **`WebSearch`** — the generic tag for provider-portable code, including
  [`webSearchTool`](/search/#drop-it-into-an-llm).

## Calling it

```ts
import { ExaSearch } from "@effect-uai/exa/ExaSearch"

const program = Effect.gen(function* () {
  const search = yield* ExaSearch
  return search.search({
    query: "papers questioning scaling laws",
    maxResults: 10,
    type: "auto", // retrieval strategy
    category: "research paper", // content vertical
  })
})
```

Every cross-provider field from [`CommonSearchRequest`](/search/#what-you-ask-for)
works here. The typed request adds:

| Field      | Values                                                        | Meaning                                     |
| ---------- | ------------------------------------------------------------- | ------------------------------------------- |
| `type`     | `auto` `fast` `instant` `deep-lite` `deep` `deep-reasoning` … | Retrieval strategy. `auto` picks per query. |
| `category` | `news` `research paper` `company` `people` …                  | Narrow the index to a vertical.             |

Exa ranks, so each result carries a `score`. Pure search returns no
`snippet` until you fetch page contents, which is a separate, planned
capability. See [what web search is not](/search/#what-web-search-is-not).

## See also

- [Web search](/search/) — the cross-provider concept and the portable
  request / result shapes.
- [Grounded answer](/recipes/grounded-answer/) — a streaming agent that
  answers from live search with citations.
