/**
 * Depth / cost knob for Perplexity's Search API (`/search`), controlling how
 * much content is extracted per result page. It trades latency / cost for
 * depth:
 *
 * - `low`: short passages most relevant to the query.
 * - `medium`: a balanced amount of content per document.
 * - `high`: detailed content (Perplexity's default).
 *
 * Provider-specific, so it lives on `PerplexitySearchRequest` rather than the
 * cross-provider `CommonSearchRequest`. Mutually exclusive with the token caps
 * (`max_tokens` / `max_tokens_per_page`): `/search` 500s if both are sent.
 */
export type PerplexitySearchContextSize = "low" | "medium" | "high"

/**
 * Models the async research endpoint (`/v1/async/sonar`) accepts. Deep research
 * is `sonar-deep-research`; the other sonar models are also submittable but are
 * meant for the sync chat endpoint, so the default is `sonar-deep-research`.
 */
export type PerplexityResearchModel =
  | "sonar-deep-research"
  | "sonar"
  | "sonar-pro"
  | "sonar-reasoning-pro"

/**
 * Depth knob for reasoning-capable models. Perplexity-specific (not on the
 * cross-provider `ResearchRequest`), it also steers how many searches
 * `sonar-deep-research` runs.
 */
export type PerplexityReasoningEffort = "minimal" | "low" | "medium" | "high"
