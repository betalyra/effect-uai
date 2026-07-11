/**
 * Perplexity's Search API takes no model identifier - unlike chat
 * completions, `/search` ranks the web directly. The one mode knob is the
 * search-context size, which trades latency / cost for depth.
 *
 * - `low` — fastest, fewest pages fetched.
 * - `medium` — balanced.
 * - `high` — most thorough (Perplexity's default).
 *
 * It is a provider-specific knob, so it lives on `PerplexitySearchRequest`
 * rather than the cross-provider `CommonSearchRequest`.
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
