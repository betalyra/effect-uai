/**
 * Exa's search mode. The `/search` endpoint has no `model`; `type` selects
 * the retrieval strategy instead, and is the one knob that makes Exa
 * distinctive (semantic / embeddings-backed search vs. keyword).
 *
 * Current documented values: `auto` (default; picks per query), `fast`,
 * `instant`, and the deep-research variants (`deep-lite`, `deep`,
 * `deep-reasoning`). The legacy `neural` / `keyword` values still work on
 * the wire; the `(string & {})` tail keeps any of them assignable without
 * an SDK bump.
 *
 * Provider-specific, so it lives on `ExaSearchRequest`, not the
 * cross-provider `CommonSearchRequest`.
 */
export type ExaSearchType =
  | "auto"
  | "fast"
  | "instant"
  | "deep-lite"
  | "deep"
  | "deep-reasoning"
  | "neural"
  | "keyword"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Exa research model for the async `/research/v1` task API (create + poll).
 * `exa-research-fast` / `exa-research` / `exa-research-pro` trade latency for
 * depth. The `(string & {})` tail accepts any string without an SDK bump.
 *
 * Note (2026-07): Exa announced `/research/v1` deprecation in favour of
 * `/search` with `type: "deep-reasoning"`. Verify the endpoint and the
 * completed-task response shape against live docs before relying on this.
 *
 * Reference: https://docs.exa.ai/reference/research/create-a-task
 */
export type ExaResearchModel =
  | "exa-research"
  | "exa-research-pro"
  | "exa-research-fast"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Exa's result category filter. Narrows the index to a content vertical.
 * Provider-specific, so it lives on `ExaSearchRequest`.
 */
export type ExaCategory =
  | "company"
  | "research paper"
  | "news"
  | "personal site"
  | "financial report"
  | "people"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Exa `/contents` freshness knob. Controls whether the page is fetched live
 * or served from Exa's cache. Provider-specific, so it lives on
 * `ExaContentsRequest`.
 */
export type ExaLivecrawl =
  | "never"
  | "fallback"
  | "preferred"
  | "always"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
