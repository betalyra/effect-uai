/**
 * Runner for the modify-output-stream recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/modify-output-stream/run.ts
 *   OPENAI_API_KEY=... bun recipes/modify-output-stream/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/modify-output-stream/run.ts
 *
 * Prints the same turn twice, once as SSE frames and once as JSONL.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
