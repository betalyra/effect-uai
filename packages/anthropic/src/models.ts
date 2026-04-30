/**
 * Known Anthropic model identifiers usable via the Messages API (as of
 * April 2026). The `(string & {})` tail keeps autocomplete on the literals
 * while still accepting any string, so newly-released models work without
 * an SDK update.
 *
 * Reference: https://platform.claude.com/docs/en/docs/about-claude/models
 *
 * Latest tier:
 * - `claude-opus-4-7` - most capable; agentic coding focus. Adaptive
 *   thinking only (no extended thinking).
 * - `claude-sonnet-4-6` - speed + intelligence balance. Extended +
 *   adaptive thinking.
 * - `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`) - fastest;
 *   extended thinking.
 *
 * Deprecated and retiring 2026-06-15:
 * `claude-sonnet-4-20250514` (`claude-sonnet-4-0`),
 * `claude-opus-4-20250514` (`claude-opus-4-0`).
 */
export type AnthropicModel =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5"
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-6"
  | "claude-sonnet-4-5"
  | "claude-sonnet-4-5-20250929"
  | "claude-opus-4-5"
  | "claude-opus-4-5-20251101"
  | "claude-opus-4-1"
  | "claude-opus-4-1-20250805"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
