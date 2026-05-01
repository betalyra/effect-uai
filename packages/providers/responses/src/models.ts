/**
 * Known OpenAI model identifiers usable via the Responses API (as of
 * April 2026). The `(string & {})` tail keeps autocomplete on the literals
 * while still accepting any string, so newly-released models work without
 * an SDK update.
 *
 * Reference: https://developers.openai.com/api/docs/models/all
 */
export type OpenAIModel =
  | "gpt-5.5"
  | "gpt-5.5-pro"
  | "gpt-5.4"
  | "gpt-5.4-pro"
  | "gpt-5.4-mini"
  | "gpt-5.4-nano"
  | "gpt-5"
  | "gpt-5-mini"
  | "gpt-5-nano"
  | "gpt-5.3-codex"
  | "gpt-4.1"
  | "gpt-4.1-mini"
  | "gpt-4o-mini"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
