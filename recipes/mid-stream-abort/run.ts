/**
 * Runner for the mid-stream-abort recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/mid-stream-abort/run.ts
 *   OPENAI_API_KEY=... bun recipes/mid-stream-abort/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/mid-stream-abort/run.ts
 *
 *   # Let it run longer before pulling the plug:
 *   ... run.ts --abort-after "10 seconds"
 *
 * Watch the partial deltas arrive, then stop. No `TurnComplete` is logged,
 * because the turn never finished.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
