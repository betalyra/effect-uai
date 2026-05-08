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

/**
 * Known OpenAI embedding model identifiers. The `-3-` line is still the
 * current general-purpose lineup; `dimensions` parameter supports
 * Matryoshka truncation up to the model's native dimensionality.
 *
 * - `text-embedding-3-small`: 1..1536 dimensions, default 1536
 * - `text-embedding-3-large`: 1..3072 dimensions, default 3072
 * - `text-embedding-ada-002`: legacy, 1536 dim, no Matryoshka
 *
 * Reference: https://developers.openai.com/api/docs/guides/embeddings
 */
export type OpenAIEmbeddingModel =
  | "text-embedding-3-small"
  | "text-embedding-3-large"
  | "text-embedding-ada-002"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
