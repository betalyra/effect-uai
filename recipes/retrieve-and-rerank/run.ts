/**
 * Runner for the retrieve-and-rerank recipe. Same file on every runtime:
 *
 *   JINA_API_KEY=... LLM_API_KEY=... pnpm tsx recipes/retrieve-and-rerank/run.ts
 *   JINA_API_KEY=... LLM_API_KEY=... bun recipes/retrieve-and-rerank/run.ts
 *   JINA_API_KEY=... LLM_API_KEY=... deno run --allow-all recipes/retrieve-and-rerank/run.ts
 *
 *   # Another question, a wider candidate set, fewer kept:
 *   ... run.ts --question "..." --candidates 25 --keep 3
 *
 * `JINA_API_KEY` alone prints the before/after ranking, which is the part
 * worth looking at; the answer model's key is only needed for the answer.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
