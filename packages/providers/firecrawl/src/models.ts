/**
 * Firecrawl's proxy tier for a scrape. Higher tiers survive more aggressive
 * anti-bot protection at higher cost. Provider-specific, so it lives on
 * `FirecrawlReadRequest`, not the cross-provider `CommonReadRequest`.
 */
export type FirecrawlProxy =
  | "basic"
  | "stealth"
  | "auto"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
