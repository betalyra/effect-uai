---
"@effect-uai/firecrawl": minor
---

Add `map` to `FirecrawlRead`. Given a base URL, Firecrawl's `POST /v2/map`
returns the site's URLs (sitemap-style discovery, with an optional `search`
filter) without scraping each page, so you can locate specific pages before a
targeted read.

`map` lives only on the provider-typed `FirecrawlRead` tag, not the generic
`WebRead` (whose contract is a single-URL read). The request is
`{ url, search?, limit?, sitemap?, includeSubdomains?, timeout? }`; the response
is `{ links: Array<{ url, title?, description? }>, raw }`. The decoder accepts
both v2 object links and older bare-string links, normalizing strings to
`{ url }`.
