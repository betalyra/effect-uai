/**
 * OpenAI regional endpoints. `eu.api.openai.com` covers `/v1/responses`
 * and `/v1/embeddings` (along with the rest of the REST surface) for
 * projects with EU data residency enabled. Keys are project-scoped.
 *
 * Reference: https://developers.openai.com/api/docs/guides/your-data
 *
 * Defined locally in this package rather than imported from
 * `@effect-uai/openai` to keep the packages decoupled.
 */

// eslint-disable-next-line @typescript-eslint/ban-types
export type OpenAiRegion = "default" | "eu" | (string & {})

const DEFAULT_HOST = "https://api.openai.com/v1"

/**
 * Resolve the HTTP base URL from a Config. `baseUrl` wins when set;
 * otherwise the host is computed from `region`. Unknown region strings
 * pass through as `{region}.api.openai.com/v1` for forward compat.
 */
export const resolveHost = (cfg: {
  readonly baseUrl?: string
  readonly region?: OpenAiRegion
}): string => {
  if (cfg.baseUrl !== undefined) return cfg.baseUrl
  if (cfg.region === undefined || cfg.region === "default") return DEFAULT_HOST
  return `https://${cfg.region}.api.openai.com/v1`
}
