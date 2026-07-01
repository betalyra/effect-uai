---
title: Market intel
description: Turn a list of vendor pricing pages into typed, validated pricing records. Read each page to clean markdown, extract it against an Effect Schema with a structured model turn, and fan the whole batch out concurrently.
source: recipes/market-intel
icon: PiTable
---

You have a list of competitor URLs and you want one clean, comparable record
per vendor: name, tiers, prices, whether there is a free tier, key features.
Every vendor lays its pricing page out differently, so there is no set of CSS
selectors that works across all of them. This is where an LLM plus a schema
beats a scraper: you describe the shape you want once, and the model fills it
from whatever the page happens to look like.

**Scenario.** Point the recipe at the pricing pages of the web-extraction
providers themselves (Firecrawl, Exa, Tavily, ScrapingBee). one charges by
credits, one per seat, one by tier, so no two pages share a layout. Each is
read to clean markdown, extracted into a typed `Product`, and the batch runs
concurrently. Pages that fail (a fetch error, a refusal, a schema mismatch)
come back as a `Result.Failure` instead of sinking the whole run.

## Read, then extract

There is no `extract` primitive. the recipe composes two you already have.
`WebRead.read(url)` returns clean markdown, and a `structured` model turn
decodes that markdown against your `Schema`:

```ts
export const extractProduct = (cfg: MarketIntelConfig, url: string) =>
  Effect.flatMap(WebRead.read({ url }), (page) => decodePage(cfg.model, page.content))
```

`decodePage` runs one `LanguageModel.streamTurn({ ..., structured: productFormat })`
and folds it down to the decoded `Product` with `Turn.decodeStructured`. The
schema is the contract: the model is told exactly which fields to return, and
the result is validated locally before you ever see it.

## Fan out, keep failures

The batch is one `Effect.forEach` with a concurrency cap. Each URL is wrapped
in `Effect.result`, so its outcome is captured as a `Result` and paired with
its URL:

```ts
Effect.forEach(
  cfg.urls,
  (url) => Effect.result(extractProduct(cfg, url)).pipe(Effect.map((r) => [url, r] as const)),
  { concurrency: cfg.concurrency },
)
```

Cap `concurrency` for your read provider's QPS. one slow or broken page never
blocks the others, and every input URL gets exactly one row out.

## Swap providers freely

`recipe.ts` names no provider. it is written against the generic `WebRead` and
`LanguageModel` tags. The backends are chosen by the Layers in `app.ts`. The
read backend is picked by `READ_PROVIDER` (`firecrawl` or `jina`), the model
by the Gemini Layer. Point `READ_PROVIDER` at a different backend and the
recipe code does not change at all; that is the whole point of the generic
tag.

## Run it

```bash
FIRECRAWL_API_KEY=... GOOGLE_API_KEY=... pnpm tsx recipes/market-intel/run-node.ts

# read with Jina instead of Firecrawl, same recipe:
READ_PROVIDER=jina JINA_API_KEY=... GOOGLE_API_KEY=... pnpm tsx recipes/market-intel/run-node.ts

# override the pages, model, or concurrency:
URLS="https://stripe.com/pricing,https://www.notion.so/pricing" CONCURRENCY=2 \
  FIRECRAWL_API_KEY=... GOOGLE_API_KEY=... pnpm tsx recipes/market-intel/run-node.ts
```

The same `app.ts` runs under Bun (`run-bun.ts`) and Deno (`run-deno.ts`); only
the platform `HttpClient` differs.

## Where to go next

- **Summarize the field.** Feed the typed records into one more model turn that
  writes a short competitive summary, so the recipe goes from extract to
  reason.
- **Persist and diff.** Store each run's records and diff them over time to
  catch a competitor's price change the day it ships.
- **Server-side extract.** Some read providers can run the extraction in one
  server-side call. when the `ServerSideExtract` fast-path lands, this recipe
  prefers it and falls back to read plus decode, with the same typed output.
