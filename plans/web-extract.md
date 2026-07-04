# Web read / extract capability — design plan

Status: draft / for discussion. Adds a `WebRead` capability (url -> clean
markdown) to effect-uai, plus a `WebExtract` story (url + schema -> typed
JSON). Companion to [search.md](search.md); same provider family, the
read/extract half it left out of scope (search.md section 1, 8).

## 1. Scope

**In scope: `WebRead` only as a capability.** Give it a URL, get clean
LLM-ready markdown with boilerplate (nav, cookie banners, newsletter
popups, footers) stripped. This is the one operation almost every
provider shares, so it needs no markers.

**`WebExtract` (url + JSON schema -> typed JSON) is a recipe, not a
capability** (section 6). It decomposes into `WebRead` + `structured-output`,
which works against every read provider. Only 4 providers do it
server-side, so a server-side fast-path is an optional capability marker,
not the primitive.

**Out of scope (noted, not built):**

- **crawl / map** (Firecrawl `/crawl` + `/map`, Tavily `/crawl` + `/map`,
  Exa `subpages`, Apify WCC, Spider `/crawl`) — multi-page traversal and
  site URL discovery. A future `WebCrawl` capability; leave room, build
  nothing.
- **CSS/XPath-selector extraction** (Spider `css_extraction_map`, Oxylabs
  Custom Parser, Diffbot Custom API, ScrapingBee legacy `extract_rules`).
  This is a _different operation_ (deterministic, selector-driven, no
  LLM) and must not be folded into `WebExtract`. Out.
- **anti-bot / proxy tuning** beyond a single `js` flag (residential
  pools, stealth, CAPTCHA, fingerprinting). Provider-typed only.

## 2. Provider reality (researched June 2026)

| Provider                          |        read -> md        |            boilerplate strip             |                    extract (LLM + arbitrary schema)                    |      js render       |   batch   | pricing model                  |
| --------------------------------- | :----------------------: | :--------------------------------------: | :--------------------------------------------------------------------: | :------------------: | :-------: | ------------------------------ |
| **Firecrawl** `/scrape`           |            ✓             | ✓ default `onlyMainContent` + `blockAds` |               ✓ `json` format / `/extract` (server LLM)                |      ✓ default       |     ✓     | credits (1/pg; extract 5/pg)   |
| **Jina Reader** `r.jina.ai`       |            ✓             |          ✓ default readability           | ✓ ReaderLM-v2 (`x-respond-with: readerlm-v2` + json-schema header) [1] |     ✓ `x-engine`     |     —     | token PAYG (~$0.05/1M tok)     |
| **Exa** `/contents`               |            ✓             |                ✓ explicit                |                       ✓ `summary` + JSON schema                        |    ✓ `livecrawl`     | ✓ `ids[]` | $1/1k pages per content-type   |
| **Tavily** `/extract`             |            ✓             |                 implicit                 |                                   ✗                                    |  ✓ `extract_depth`   |   ✓ ≤20   | credits (1/5 urls)             |
| **Spider.cloud** `/scrape`        |            ✓             |        ✓ `return_format=markdown`        |                              ✗ (CSS only)                              |  ✓ `request` modes   |     ✓     | PAYG bandwidth+CPU (~$0.48/1k) |
| **Apify WCC**                     |            ✓             |         ✓ `saveMarkdown` default         |                          ✗ (separate actors)                           | ✓ Playwright/Cheerio |     ✓     | compute-unit (~$0.2-5/1k)      |
| **ScrapingBee**                   | ✓ `return_page_markdown` |          ✓ `markdown_relevant`           |                   ✓ `ai_extract_rules` + `ai_query`                    |      ✓ default       |     —     | credits (+5/extract)           |
| **Bright Data** Web Unlocker      | ✓ `data_format:markdown` |                    ✓                     |                      ✗ (per-domain scrapers only)                      |   ✓ best-in-class    |     —     | pay-per-success (~$1.5-3/1k)   |
| **Oxylabs** Web Scraper API       |    ✓ `markdown:true`     |                    ✓                     |                       ✗ (CSS Custom Parser only)                       |   ✓ `render:html`    |     —     | pay-per-result (~$0.4-2/1k)    |
| **Diffbot** Analyze/Article       |     ✗ (clean `text`)     |                    ✓                     |                        ✗ (fixed ontology + CSS)                        |         auto         |     ✓     | credits (1/pg, $299/mo+)       |
| **Zyte** API                      |     ✗ (HTML, no md)      |                    ✓                     |           ✓ `customAttributes` (OpenAPI-subset schema + LLM)           |   ✓ `browserHtml`    |     ✓     | pay-per-success, tiered        |
| **ScrapeGraphAI** `/smartscraper` |  ~ (separate endpoint)   |                    ✓                     |                    ✓ `output_schema` (Zod/Pydantic)                    |          ✓           |     —     | credits (~5/call)              |

[1] Jina splits two header families. **HTML output is confirmed**:
`X-Return-Format: html` (also `markdown`/`text`/`screenshot`/`pageshot`).
**Structured extraction** is the unverified one: `x-respond-with:
readerlm-v2` plus a JSON-schema header, inconsistently documented across
Jina's own pages. The HTML path can be wired now; confirm the extraction
headers against live docs before wiring Jina into `ServerSideExtract`
(section 6).

[2] **HTML output, re-checked June 2026 (see section 4 `format`).** The
scraper-family providers are HTML-native and treat markdown as the _added_
cleaning pass, so HTML is broadly available, not rare: Firecrawl (`html`
cleaned + `rawHtml` unmodified), Jina (`X-Return-Format: html`), Spider,
ScrapingBee, Bright Data, Oxylabs all return it, and **Exa** does too via
`text: { includeHtmlTags: true }`. The only read provider with no HTML
path is **Tavily** (`format` is `markdown | text` only). That is 7 of 8
wired providers, which is why `format: "html"` earns the common floor with
a single Tavily warn-fallback rather than living as provider-typed
best-effort.

**Read:** 9 of 12 providers (all but Diffbot, Zyte, which return HTML
only). Strong, cohesive capability. **Extract (LLM + arbitrary schema):**
6 (Firecrawl, Jina, Exa, ScrapingBee, Zyte, ScrapeGraphAI). Enough for a
real abstraction, but a divergent set spanning credits / tokens /
per-success and three different schema dialects (JSON Schema, Zod/
Pydantic, OpenAPI-subset), which is exactly why extract is a recipe with
an optional server-side fast-path, not a primitive. Excluded:
**Browserbase/Stagehand** (`page.extract()` is stateful navigate-then-
extract, not one-shot `read(url)`); **Perplexity** (its `/search` has
`search_context_size` / `max_tokens_per_page`, but those scope how much
text comes back _from search results_ — there is no `read(url) -> content`
operation; you cannot hand it a URL and get that page, so it stays
`WebSearch`-only); **SerpApi** (SERP parsing, belongs to `WebSearch`);
Olostep / Scrapingdog (niche).

## 3. Why `WebRead` is the primitive

Same test as every other capability: irreducible provider protocol,
3+/N providers, a developer expects it from a generic interface. Read
passes cleanly. The value (JS render, anti-bot survival, HTML ->
clean-markdown) cannot be reconstructed from `HttpClient` + an LLM, so
it is a provider protocol, the exact shape of `WebSearch`. The
differentiator across providers (cleaning quality, render fidelity,
anti-bot success) is non-portable; the capability guarantees the
_contract_ (url -> markdown), not the quality, identical to how
`LanguageModel` abstracts wildly varying model quality.

## 4. Core types

Location: `packages/core/src/web-read/WebRead.ts`, exported as
`@effect-uai/core/WebRead`. Tag identifier `@betalyra/effect-uai/WebRead`
(tag-string scope `@betalyra/effect-uai`, matching every existing tag).

```ts
export type WebReadService = {
  readonly read: (request: CommonReadRequest) => Effect.Effect<ReadResponse, AiError.AiError>
}

export class WebRead extends Context.Service<WebRead, WebReadService>()(
  "@betalyra/effect-uai/WebRead",
) {}

export const read = (
  request: CommonReadRequest,
): Effect.Effect<ReadResponse, AiError.AiError, WebRead> =>
  Effect.flatMap(WebRead.asEffect(), (s) => s.read(request))
```

### Request: `CommonReadRequest`

Field earns the common floor only if most providers support it and a
developer expects it from a generic reader. Support matrix:

| Field                         |   FC    |    Jina     |   Exa   | Tavily  | Spider | ScrBee |  BD  | Oxy  |           Common?            |
| ----------------------------- | :-----: | :---------: | :-----: | :-----: | :----: | :----: | :--: | :--: | :--------------------------: |
| `url` (single)                |    ✓    |      ✓      |    ✓    |    ✓    |   ✓    |   ✓    |  ✓   |  ✓   |           **yes**            |
| `mainContentOnly` (toggle)    |  bool   |   default   | default | default |  bool  |  bool  | bool | bool |         no -> typed          |
| `js` (render on/off)          | on-only | engine enum |  auto   |  depth  |  bool  |  bool  | bool | bool |         no -> typed          |
| `format` markdown             |    ✓    |      ✓      |    ✓    |    ✓    |   ✓    |   ✓    |  ✓   |  ✓   | **yes** (default; universal) |
| `format` html                 |    ✓    |      ✓      | ✓ tags  |    ✗    |   ✓    |   ✓    |  ✓   |  ✓   |  **yes** (7/8; Tavily warn)  |
| `format` rawHtml (unmodified) |    ✓    |      ~      |    ✗    |    ✗    |   ✓    |   ✓    |  ✗   |  ✗   |         no -> typed          |
| `timeout`                     |    ✓    |      ✓      |    ✓    |    ✓    |   ~    |   ~    |  ~   |  ~   |      **yes** (optional)      |
| `query` (relevance chunks)    |    ✗    |      ✗      |    ✓    |    ✓    |   ✗    |   ✗    |  ✗   |  ✗   |         no -> typed          |
| `urls[]` (batch)              |    ✓    |      ✗      |    ✓    |    ✓    |   ✓    |   ✗    |  ✗   |  ✗   |   no -> typed (see below)    |

```ts
export type CommonReadRequest = {
  readonly url: string
  readonly format?: "markdown" | "html" // markdown default; html is 7/8 (Tavily warn-falls-back); rawHtml stays provider-typed
  readonly timeout?: Duration.Duration
}
```

Decisions baked in:

- **`mainContentOnly` and `js` are provider-typed, not common.** Clean
  main-content output is the shared _default behavior_ (every provider
  strips boilerplate by default), so the capability promises that default.
  but the _toggles_ are not unified: only the scraper-family providers
  expose a real `mainContentOnly` boolean and a real JS on/off, while the
  reader-family (Jina engine enum, Exa auto-render, Tavily depth, Firecrawl
  always-on) express it differently or not at all. Forcing a `boolean`
  onto the floor would fake a uniformity that isn't there, so both live on
  the provider-typed request where they're genuinely supported (e.g.
  `FirecrawlRead.onlyMainContent`, `JinaReader.engine`). Note: Exa
  `livecrawl` is cache-_freshness_, not JS rendering. the two are
  orthogonal and neither maps to a common `js`.
- **`format` floor is `markdown | html`.** Two representations, no more.
  Markdown is universal and the default (the LLM-ready point of the
  capability). The June-2026 re-check (section 2 note [2]) promotes
  **`html`** to the floor: it is supported by 7 of the 8 wired providers
  (FC/Jina/Exa-via-`includeHtmlTags`/Spider/ScrapingBee/BD/Oxylabs), since
  most are HTML-native scrapers with markdown as the added clean pass. The
  lone holdout is **Tavily**, which `warnDropped`s and falls back to
  markdown. `"html"` means "an HTML representation, cleaned where the
  provider cleans"; a _guaranteed unmodified_ `rawHtml` is a stronger
  contract only FC/Spider/ScrapingBee expose distinctly, so it stays
  provider-typed. **`text` is dropped from the floor**: it is just
  formatting-stripped markdown, trivially derivable by the caller, and
  only a couple of providers expose it as a distinct mode — not worth a
  third floor value.
- **No common batch.** FC/Exa/Tavily/Spider take URL arrays; Jina /
  ScrapingBee / BD / Oxylabs are one-URL-per-call. That is a split, so
  the common surface is single-URL `read(url)`; batch is a provider-typed
  `readMany` where supported, and the portable path is
  `Effect.forEach(urls, read, { concurrency })`.

### Response: `ReadResponse`

```ts
export type ReadResponse = {
  readonly url: string
  readonly content: string // the point; the requested representation (markdown default, or html)
  readonly title?: string // FC, Jina frontmatter, Exa, most
  readonly links?: ReadonlyArray<string> // FC links, Jina x-retain-links; optional
  // No typed `usage`. Mirrors `SearchResponse` (WebSearch.ts): Embedding /
  // Transcriber CAN model usage because token-usage is homogeneous, but read
  // providers bill in divergent units (Firecrawl credits, Jina tokens, Exa
  // USD/page, BD/Oxylabs per-success), so a typed field would force a fake
  // common shape. Deferred to plans/usage-tracking.md; whatever the provider
  // reports survives on `raw`.
  readonly raw: unknown // provider-native, never lossy
}
```

Naming note: the field is `content`, not `markdown`, because `format` can be
`html`. Calling it `markdown` while it sometimes holds HTML would lie. This
differs intentionally from an earlier `markdown`-named draft.

## 5. Provider packages

| Provider    | npm package               | typed tag         | note                                                     |
| ----------- | ------------------------- | ----------------- | -------------------------------------------------------- |
| Firecrawl   | `@effect-uai/firecrawl`   | `FirecrawlRead`   | **new** — the one new package; flagship (read + extract) |
| Jina        | `@effect-uai/jina`        | `JinaReader`      | extend (already has `JinaEmbedding`)                     |
| Exa         | `@effect-uai/exa`         | `ExaContents`     | extend (already has `ExaSearch`)                         |
| Tavily      | `@effect-uai/tavily`      | `TavilyRead`      | extend (already has `TavilySearch`)                      |
| ScrapingBee | `@effect-uai/scrapingbee` | `ScrapingBeeRead` | _deferred_ (section 11) — read + ai-extract              |
| Bright Data | `@effect-uai/brightdata`  | `BrightDataRead`  | _deferred_ (section 11) — anti-bot tier                  |

The initial scope is the top four: **Firecrawl** (the only new package)
plus a second tag on the existing **jina / exa / tavily** packages.
ScrapingBee and Bright Data are listed for design completeness but
deferred to build-on-demand.

One package per provider brand (memory). Exa/Tavily/Jina gain a second
typed tag on the existing package, exactly as `JinaEmbedding` and a new
`JinaReader` coexist. Spider / Apify / Oxylabs / Diffbot are deferred
(section 11), not rejected.

**Tag names follow the capability, not the endpoint URL.** Tavily's read
endpoint is literally `/extract`, but its tag is `TavilyRead`, not
`TavilyExtract`: Tavily cannot do LLM `WebExtract` (section 2: extract
✗), so an `…Extract`-named tag would advertise exactly the capability it
lacks and undercut the WebRead-vs-WebExtract split this plan rests on.
`ExaContents` and `JinaReader` are fine (neither evokes extract);
`FirecrawlRead` (and the deferred `ScrapingBeeRead` / `BrightDataRead`)
are uniform. Each
provider's `layer` registers both its typed tag and the generic `WebRead`
tag over one impl, exactly as `ExaSearch.layer` registers `ExaSearch +
WebSearch` (`Layer.merge`).

## 6. `WebExtract`: recipe + optional marker

`extract(url, schema) -> A` is **not a capability**. Default
implementation is a recipe:

```
read(url) |> StructuredFormat decode against `schema` via LanguageModel
```

This works against **all 9** read providers and reuses
`structured-output` unchanged. It is the honest primitive composition and
follows the "no per-provider shortcuts over generic helpers" memory.

**Optional server-side fast-path.** Some providers can run the extraction
server-side in one call (cheaper, no page round-trip). Expose it as a
`ServerSideExtract` capability marker, mechanically identical to
`SttStreaming` on `Transcriber` ([Transcriber.ts:83](../packages/core/src/transcriber/Transcriber.ts#L83)):
a phantom `void` service whose presence in `R` gates the helper at
`Effect.provide` (a type error, not a runtime check) when no server-side
provider Layer is in scope.

```ts
// Phantom marker — providers with a server-side extract register it via
// `Layer.succeed(ServerSideExtract, undefined)`; others don't ship it.
export class ServerSideExtract extends Context.Service<ServerSideExtract, void>()(
  "@betalyra/effect-uai/capability/ServerSideExtract",
) {}

// The marker rides the R channel, exactly like `streamTranscriptionFrom`.
export const extractServerSide = (
  request: ExtractRequest,
): Effect.Effect<ExtractResponse, AiError.AiError, WebRead | ServerSideExtract> => /* … */
```

The recipe (`webExtract`) yields the marker opportunistically: server-side
when a marked Layer is present, otherwise read + structured-output. Same
model-facing contract either way.

**Schema-dialect scope — narrow the first cut.** The server-side-extract
providers disagree on schema dialect: Firecrawl/Jina/Exa/ScrapingBee take
**JSON Schema** (which `structured-output` already emits from an Effect
`Schema`), ScrapeGraphAI takes **Zod/Pydantic**, Zyte an **OpenAPI
subset**. Only the JSON-Schema dialect is free today. So `ServerSideExtract`
ships against the JSON-Schema providers we actually wire — **Firecrawl,
Jina, and Exa** (ScrapingBee is deferred with the rest of section 11);
ScrapeGraphAI and Zyte's dialects are explicitly out, not implied by the
phasing. Note Jina's extraction headers are still unverified (section 2
note [1]) — confirm before marking Jina.

## 7. The tool — `webReadTool`

Symmetric to the shipped `webSearchTool` (search.md section 12). The loop
needs "read this URL" as much as "search the web"; the deep-research
recipe (search.md section 13) today leans on search-result snippets and
cannot fetch a named page. `R = WebRead`.

```ts
export const webReadTool = (options?: {
  readonly name?: string // default "read_url"
  readonly format?: ReadFormat // app default "markdown"
  readonly maxChars?: number // truncate the returned content (default e.g. 50_000); see below
}): Tool.Tool<"read_url", { url: string }, string, WebRead> => /* read(args.url) -> content string */
```

**The length ceiling is the one real divergence from `webSearchTool`.**
A search tool's output is naturally bounded (`maxResults` × a ~500-char
snippet); a _read_ tool returns a whole page, and a single readable
article is routinely 50-200 KB of markdown. Unbounded, one `read_url`
call can blow the model's context window in a single turn. So `webReadTool`
takes an app-set `maxChars` (a cost/context ceiling, model-invisible like
`maxResults`), truncates with an explicit `… [truncated N chars]` marker,
and defaults to a sane cap rather than the full page. This is a real
design point, not a footnote: without it the tool is a context bomb.

Backed by the generic `WebRead` tag, never a provider tag, so swapping
Firecrawl for Jina changes nothing the model sees. A `webExtractTool`
(input: url + the app-fixed schema, output: typed JSON) is the recipe's
tool form, added with the recipe.

## 8. Capability-honesty mapping

Existing three buckets (`Unsupported` / `Capabilities.warnDropped` /
silent-provider-typed):

- **`format: "html"` on Tavily** (the lone read provider with no HTML
  path) -> `warnDropped` + fall back to markdown. Resolved to
  warn-fallback, not `Unsupported`: HTML is a representation choice, not a
  shape mismatch, and silently degrading one field beats failing the call.
  Implemented exactly like `ExaSearch`'s missing-`language` handling
  ([ExaSearch.ts:199-209](../packages/providers/exa/src/ExaSearch.ts#L199-L209))
  via `Capabilities.warnDroppedWhen`. Every other read provider maps
  `html` natively.
- **`mainContentOnly` / `js` are not on the common floor** (they are
  provider-typed, see section 4), so there is nothing to warn or drop on
  the generic surface. Each provider's typed request exposes whatever
  toggle it genuinely has.
- **Provider-only knobs** (FC `actions`/`proxy`, Jina `x-engine`/
  `x-with-generated-alt`, Exa `livecrawlTimeout`) -> silent,
  provider-typed request only.

## 9. Errors

Reuse `AiError` unchanged: 401/403 -> `AuthFailed`; 429 -> `RateLimited`
(honor `Retry-After`); 400 -> `InvalidRequest`; per-URL crawl failures
(Exa `statuses`, SOURCE_NOT_AVAILABLE / CRAWL_TIMEOUT) -> map to
`Unavailable` / `Timeout` on the single-URL result. No new variants.

## 10. Package layout & versioning

```
packages/core/src/web-read/WebRead.ts      -> @effect-uai/core/WebRead
packages/core/src/web-read/WebReadTool.ts  -> @effect-uai/core/WebReadTool
packages/providers/firecrawl/              -> @effect-uai/firecrawl   (new; the one new package)
packages/providers/{jina,exa,tavily}/      -> add JinaReader / ExaContents / TavilyRead tag
```

Only one new package ships now (`firecrawl`); the rest are second tags on
already-maintained packages. The new package debuts at the current
fixed-group version (memory; confirm the live number), bumped with the
others as one umbrella `minor` changeset. Add `"./WebRead"` +
`"./WebReadTool"` to core exports. ScrapingBee / Bright Data and the rest
are deferred (section 11) — no `scrapingbee` / `brightdata` package yet.

## 11. Phasing

The first cut is **the existing provider packages + Firecrawl** — only
one new package. ScrapingBee, Bright Data, and the others are deferred to
build-on-demand (below), not part of the initial scope.

1. **Core + tool + 2 providers.** `WebRead` + `webReadTool`, then
   **Firecrawl** (richest, the reference, the only new package) and
   **Jina** (cheap token PAYG, header-driven, a second tag on the existing
   jina package). Ship a `basic-read` recipe.
2. **Reuse existing packages.** Add `ExaContents` and `TavilyRead` to the
   exa/tavily packages (the unwrapped endpoints already noted in
   `ExaSearch.ts`). Now read spans 4 backends on 3 maintained packages,
   zero further new packages.
3. **`WebExtract` recipe + `ServerSideExtract` marker.** Recipe over read
   - structured-output (works on all 4 backends); mark **FC/Jina/Exa** for
     the JSON-Schema server-side path (section 6). No new provider in this
     phase.
4. **Deferred — build on demand.** **ScrapingBee** (read +
   `ai_extract_rules`), **Bright Data** / **Oxylabs** (anti-bot tier for
   hard/protected sites), **Spider**, **Apify WCC**, **Diffbot**. None
   blocks the design; each is a new package added when a use case asks for
   it.

## 12. Open questions

1. **Capability split: one `WebRead` or `WebRead` + `WebExtract` tags?**
   **Resolved:** one capability (`WebRead`) + `ServerSideExtract` marker,
   extract as a recipe (section 6). Avoids a thin 4-provider capability.
2. **`html` format on the lone holdout (Tavily).** **Resolved:**
   warn-fallback to markdown, not `Unsupported` (section 8). The June-2026
   re-check (section 2 note [2]) made this easy — html is 7/8, so only
   Tavily degrades. A guaranteed-unmodified `rawHtml` stays provider-typed.
3. **Batch**: provider-typed `readMany` vs always `Effect.forEach`.
   Recommend `Effect.forEach(urls, read, { concurrency })` for the portable
   path, `readMany` only where the provider bills batch cheaper (Tavily
   1 credit / 5 urls).
4. **Jina extraction headers** unverified (section 2 note [1]); confirm
   before wiring Jina into `ServerSideExtract`. HTML output is already
   confirmed, so it does not block the read path.
5. **`mainContentOnly` / `js` placement.** **Resolved:** off the common
   floor, onto provider-typed requests (section 4). Clean main-content is
   the promised default behavior; the _toggles_ aren't unified across
   providers, so a common `boolean` would fake uniformity that isn't there.
