/**
 * Known Jina embedding model identifiers.
 *
 * - `jina-embeddings-v4` — flagship multimodal (text + image), 32k context.
 *   Tasks: `retrieval`, `text-matching`, `code` (LoRA-bound). Query and
 *   document modes share the `retrieval` task; the model handles the
 *   distinction internally.
 * - `jina-embeddings-v5-text-small` / `-nano` — fifth-gen text-only,
 *   released Feb 2026. Multilingual, Matryoshka, GGUF-quantizable for
 *   edge deployment.
 * - `jina-embeddings-v3` — legacy text-only. Tasks: `retrieval.query`,
 *   `retrieval.passage`, `text-matching`, `classification`, `separation`.
 * - `jina-clip-v2` — CLIP-style multimodal embedding.
 *
 * The `(string & {})` tail accepts any string so newly-released models
 * work without an SDK update.
 *
 * Reference: https://jina.ai/embeddings/
 */
export type JinaEmbeddingModel =
  | "jina-embeddings-v4"
  | "jina-embeddings-v5-text-small"
  | "jina-embeddings-v5-text-nano"
  | "jina-embeddings-v3"
  | "jina-clip-v2"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Known Jina reranker model identifiers.
 *
 * - `jina-reranker-v3.5`: flagship listwise reranker, 131k context.
 * - `jina-reranker-v3`: previous generation, schema-identical.
 * - `jina-reranker-m0`: multimodal, takes `{ text }` / `{ image }`
 *   documents (see `JinaRerankRequest`).
 *
 * Reference: https://jina.ai/reranker/
 */
export type JinaRerankerModel =
  | "jina-reranker-v3.5"
  | "jina-reranker-v3"
  | "jina-reranker-m0"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Reader fetching engine (`X-Engine`). `browser` renders JavaScript,
 * `curl` is a fast static fetch, `auto` picks per page. Provider-specific,
 * so it lives on `JinaReadRequest`.
 */
export type JinaEngine =
  | "browser"
  | "curl"
  | "auto"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
