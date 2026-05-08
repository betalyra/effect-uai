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
