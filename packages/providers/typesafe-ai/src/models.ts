/**
 * Jev model identifiers.
 *
 * - `jev-latest` — most recent stable release, the SDK default.
 * - `jev-preview` — currently identical to `jev-latest`.
 * - `jev-1.13.0` — pinned.
 *
 * 64k tokens per request, of which ~32k for the encoded input plus the
 * longest single decision. Text only.
 *
 * The `(string & {})` tail accepts any string so new releases work without
 * an SDK update.
 */
export type JevModel =
  | "jev-latest"
  | "jev-preview"
  | "jev-1.13.0"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
