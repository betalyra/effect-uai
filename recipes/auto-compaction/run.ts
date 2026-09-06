/**
 * Runner for the auto-compaction recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/auto-compaction/run.ts
 *   OPENAI_API_KEY=... bun recipes/auto-compaction/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/auto-compaction/run.ts
 *
 * Watch `input_tokens` on each logged turn: it climbs, then drops the turn
 * after compaction fires.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
