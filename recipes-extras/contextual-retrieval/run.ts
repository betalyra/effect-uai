/**
 * Runner for the contextual-retrieval recipe. Same file on every runtime:
 *
 *   pnpm -C recipes-extras/contextual-retrieval install
 *   JINA_API_KEY=jina_... LLM_API_KEY=sk-or-... pnpm -C recipes-extras/contextual-retrieval start "your question"
 *
 * The first run downloads the book, chunks it, embeds it, and writes
 * `rag.db`. Later runs reuse both. Only ever run one writer at a time: the
 * libsql vector index does not tolerate concurrent writers.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
