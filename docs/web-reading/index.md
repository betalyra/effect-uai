---
title: Web reading
description: Give your agent a URL and get clean, LLM-ready content back. One generic service tag, swappable read backends, and a schema-driven path to typed extraction.
icon: PiArticle
---

Models work with text, not URLs. To put a web page in a prompt you first
have to fetch it and clean it up, since the raw HTML is mostly navigation,
cookie banners, and footers. `WebRead` is that step: give it a URL, get the
page back as markdown with the boilerplate removed.

Every provider registers under both its own typed tag (`FirecrawlRead`) and
the generic `WebRead` tag. Write against `WebRead` and your code is portable
across backends; reach for the typed tag when you want a provider's own
options.

## One operation

Reading a URL to clean content is the one thing every backend does the same
way, so there are no capability markers here. Every provider can answer.

```ts
import { read } from "@effect-uai/core/WebRead"

const { content } = yield * read({ url: "https://effect.website/docs" })
// content: clean markdown, portable across providers
```

## What you ask for

The request only carries fields every backend supports:

```ts
interface CommonReadRequest {
  readonly url: string
  readonly format?: "markdown" | "html" // markdown default
  readonly timeout?: Duration
}
```

Markdown, cleaned down to the main content, is the default. Options that
providers implement differently (JS rendering, how aggressively to strip a
page, proxy settings) stay on the typed request rather than a shared flag
only some backends could honor. `html` works on almost every backend; the
few without it warn and fall back to markdown.

## What you get back

```ts
interface ReadResponse {
  readonly url: string
  readonly content: string // the requested representation (markdown or html)
  readonly title?: string
  readonly links?: ReadonlyArray<string>
  readonly raw: unknown // the provider's untouched response, never lossy
}
```

Whatever a provider returns beyond these fields stays on `raw`, reachable
when you hold the typed tag.

## Extract typed data

Often you don't want the whole page, just one value from it: a price, a spec
table, a job's salary range. That is `read` plus [structured
output](/recipes/structured-output/): fetch the page to markdown, then decode
it against an Effect `Schema` in one model turn. There are no selectors, so
the same extractor works on pages that share no layout.

[Market intel](/recipes/market-intel/) runs this over a batch of vendor
pricing pages, extracting a typed record from each, with the read backend
and the model both swappable.

## Swap backends at the layer

Provide one provider `layer` and your `WebRead`-yielding code resolves.

| Provider     | Package                 | Notes                                          |
| ------------ | ----------------------- | ---------------------------------------------- |
| Firecrawl    | `@effect-uai/firecrawl` | JS render, main-content strip, markdown/html   |
| Jina Reader  | `@effect-uai/jina`      | Header-driven, token-priced, markdown/html     |

```ts
import { layer as firecrawl } from "@effect-uai/firecrawl/FirecrawlRead"
import { layer as jina } from "@effect-uai/jina/JinaReader"
```

More backends (Exa contents, Tavily extract) register the same `WebRead` tag
and slot in with no code change. To switch, switch the layer.

## What web reading is not

- **Not web search.** Reading takes a URL you already have and returns that
  one page. Finding URLs is [web search](/search/).
- **Not crawl or map.** Reading is single-page. Following links across a
  site is a separate, planned capability.
- **Not a selector engine.** `WebRead` returns the whole cleaned page;
  deterministic CSS/XPath extraction is a different, non-LLM operation.

## See also

- [Web search](/search/): find the URLs, then read them.
- [Market intel](/recipes/market-intel/): read plus extract, end to end.
