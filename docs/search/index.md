---
title: Web search
description: Give your agent live web results. One generic service tag, swappable search backends, and a ready-made tool for grounding an LLM.
icon: PiMagnifyingGlass
---

A language model only knows what it was trained on. Ask it about this
morning's release, a number that changed yesterday, or a page it never
saw, and it guesses. Web search closes that gap: you hand the model live
results and it answers from them, with sources.

`WebSearch` is the generic provider tag for that work. Every provider's
`layer` registers itself under both its own typed tag (`PerplexitySearch`,
`ExaSearch`, `TavilySearch`) _and_ `WebSearch`. Code that yields
`WebSearch` is portable across backends; code that yields the typed tag
gets that provider's own knobs.

This is the same seam the [embedding model](/embeddings/) uses. Different
capability, same idea.

## One operation

Search is the one thing every backend does the same way: a query in,
ranked results out. So unlike speech or embeddings there are no capability
markers to reason about. Every provider can answer.

```ts
import { search } from "@effect-uai/core/WebSearch"

const { results } = yield * search({ query: "effect-ts v4 release notes" })
// results: ReadonlyArray<SearchResult>, portable across providers
```

## What you ask for

The request carries only the fields most backends honor, so the same
request works everywhere:

```ts
interface CommonSearchRequest {
  readonly query: string
  readonly maxResults?: number
  readonly includeDomains?: ReadonlyArray<string>
  readonly excludeDomains?: ReadonlyArray<string>
  readonly recency?: "hour" | "day" | "week" | "month" | "year"
  readonly startDate?: DateTime // precise alternative to recency
  readonly endDate?: DateTime
  readonly country?: string // ISO alpha-2
  readonly language?: string // ISO 639-1
}
```

Notice there is no `model`. Pure search has nothing to pick. What looks
model-shaped on a given backend (Exa's `type`, Tavily's `searchDepth`) is
a provider mode knob, so it lives on that provider's typed request, not the
portable floor. Where a backend can't honor a common field (Tavily has no
language filter, say), the adapter warns rather than failing the call.

## What you get back

A flat record with optionals. the backends differ by which fields they
fill, not by kind:

```ts
interface SearchResult {
  readonly url: string
  readonly title?: string
  readonly snippet?: string // the short excerpt every backend that has one returns
  readonly publishedDate?: DateTime
  readonly score?: number // relevance, from the backends that rank (Exa, Tavily)
  readonly raw: unknown // the provider's untouched result, never lossy
}
```

Anything a provider returns that is not promoted here (an author, a
favicon, a richer snippet array) survives on `raw`, reachable when you hold
the typed tag.

## Drop it into an LLM

Grounding a model is what most people reach for search to do. effect-uai
ships the glue as a one-liner: `webSearchTool` is a ready-made tool whose
only requirement is `WebSearch`.

```ts
import { webSearchTool } from "@effect-uai/core/WebSearchTool"

const tools = [webSearchTool({ maxResults: 5 })]
```

Because the tool sits on the generic tag, the contract the model sees (its
name, description, and arguments) is identical no matter which backend
answers. Swap `PerplexitySearch.layer` for `ExaSearch.layer` and neither
your program nor the model's tool changes. The model controls the `query`
and a `recency` hint; domain allow / deny lists and the result cap are app
policy, pinned on the tool rather than left to the model to remember.

See [grounded answer](/recipes/grounded-answer/) for the full agent: the
model searches, reads, searches again, and writes a cited answer, with the
LLM and the search backend swappable independently.

## Swap backends at the layer

Provide one provider `layer` and your `WebSearch`-yielding code resolves.
Three backends ship today:

| Provider   | Package                  | Returns         | Good for                                  |
| ---------- | ------------------------ | --------------- | ----------------------------------------- |
| Perplexity | `@effect-uai/perplexity` | snippet         | fast, current-events snippets             |
| Exa        | `@effect-uai/exa`        | score           | neural / semantic search, ranked by score |
| Tavily     | `@effect-uai/tavily`     | snippet + score | snippets and scores with depth control    |

```ts
import { layer as perplexity } from "@effect-uai/perplexity/PerplexitySearch"
import { layer as exa } from "@effect-uai/exa/ExaSearch"
import { layer as tavily } from "@effect-uai/tavily/TavilySearch"
```

They genuinely disagree on the same query: a neural backend (Exa), a
keyword-and-snippet backend, and an independent index rank results
differently, which is exactly why the portable seam is useful. To switch,
switch the layer.

## What web search is not

- **Not extract or crawl.** Search returns ranked links and short
  snippets. Pulling full page text (Exa's `contents`, Tavily's `extract`)
  is a separate, planned capability. Exa's pure search, for instance,
  returns no snippet until you fetch contents.
- **Not an answer engine.** Provider answer modes (Perplexity Sonar,
  Tavily's `include_answer`) synthesize prose for you. effect-uai keeps
  search and the LLM separate so you choose the model. that is what
  [grounded answer](/recipes/grounded-answer/) demonstrates.
- **Not a reranker.** `SearchResult.score` is the provider's own ranking;
  cross-encoder re-scoring is [reranking](/reranking/) (planned).

## Next step

Try [grounded answer](/recipes/grounded-answer/): a streaming agent that
answers a current-events question from live search, with inline citations
and a swappable LLM and search backend.

## See also

- [Embeddings](/embeddings/) for semantic retrieval over your own corpus,
  the other half of the retrieval story.
- [Reranking](/reranking/) (planned) for sharpening the top results.
