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
