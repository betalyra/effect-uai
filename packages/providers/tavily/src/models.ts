/**
 * Tavily's search-depth knob. `/search` takes no `model`; depth trades
 * latency / credit cost for thoroughness (`basic` and `fast` cost 1 API
 * credit, `advanced` costs 2). Provider-specific, so it lives on
 * `TavilySearchRequest`.
 */
export type TavilySearchDepth = "basic" | "advanced" | "fast" | "ultra-fast"

/**
 * Tavily's topic filter. Selects the index vertical; `news` also unlocks
 * day-windowed recency and per-result `published_date`. Provider-specific.
 */
export type TavilyTopic = "general" | "news" | "finance"
