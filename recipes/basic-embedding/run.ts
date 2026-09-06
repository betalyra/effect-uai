/**
 * Runner for the basic-embedding recipe. Same file on every runtime:
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/basic-embedding/run.ts
 *   GOOGLE_API_KEY=... bun recipes/basic-embedding/run.ts
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/basic-embedding/run.ts
 *
 *   # Any other embedding provider the registry knows:
 *   OPENAI_API_KEY=... ... run.ts --model openai:text-embedding-3-small
 *   JINA_API_KEY=...   ... run.ts --model jina:jina-embeddings-v4
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
