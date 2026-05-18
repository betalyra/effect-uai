/**
 * OpenAI regional endpoints. `eu.api.openai.com` covers the same paths
 * as the default host (REST + Realtime WS) for projects with EU data
 * residency enabled. Keys are project-scoped, so an EU-project key must
 * be used against the EU host.
 *
 * Reference: https://developers.openai.com/api/docs/guides/your-data
 */

// eslint-disable-next-line @typescript-eslint/ban-types
export type OpenAiRegion = "default" | "eu" | (string & {})

const DEFAULT_HOST = "https://api.openai.com/v1"

/**
 * Resolve the HTTP base URL from a Config. `baseUrl` is the universal
 * escape hatch and wins when set. Otherwise the host is computed from
 * `region`; unknown region strings are passed through verbatim as a
 * `{region}.api.openai.com/v1` host, so newly-introduced regions work
 * without an SDK update.
 *
 * Realtime WS code derives its `wss://` URL by substituting `http→ws`
 * on the resolved host.
 */
export const resolveHost = (cfg: {
  readonly baseUrl?: string
  readonly region?: OpenAiRegion
}): string => {
  if (cfg.baseUrl !== undefined) return cfg.baseUrl
  if (cfg.region === undefined || cfg.region === "default") return DEFAULT_HOST
  return `https://${cfg.region}.api.openai.com/v1`
}
