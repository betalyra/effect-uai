/**
 * ElevenLabs regional residency endpoints. The default workspace runs
 * against `api.elevenlabs.io`; EU- and IN-residency workspaces run
 * against `api.{eu,in}.residency.elevenlabs.io` (REST + WSS).
 *
 * API keys are workspace-bound — a key minted in an EU workspace must
 * be used against the EU host (and vice versa). Mixing key/host
 * surfaces as `401 PERMISSION_DENIED`.
 *
 * Reference: https://elevenlabs.io/docs/overview/administration/data-residency
 */

// eslint-disable-next-line @typescript-eslint/ban-types
export type ElevenLabsRegion = "default" | "eu" | "in" | (string & {})

const DEFAULT_HOST = "https://api.elevenlabs.io/v1"

/**
 * Resolve the HTTP base URL from a Config. `baseUrl` wins when set;
 * otherwise the host is computed from `region`. Unknown region strings
 * pass through as `api.{region}.residency.elevenlabs.io/v1` for forward
 * compat.
 *
 * WS code derives its `wss://` URL by substituting `http→ws` on the
 * resolved host.
 */
export const resolveHost = (cfg: {
  readonly baseUrl?: string
  readonly region?: ElevenLabsRegion
}): string => {
  if (cfg.baseUrl !== undefined) return cfg.baseUrl
  if (cfg.region === undefined || cfg.region === "default") return DEFAULT_HOST
  return `https://api.${cfg.region}.residency.elevenlabs.io/v1`
}
