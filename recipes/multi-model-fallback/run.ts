/**
 * Runner for the multi-model-fallback recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... GOOGLE_API_KEY=... pnpm tsx recipes/multi-model-fallback/run.ts
 *   OPENAI_API_KEY=... GOOGLE_API_KEY=... bun recipes/multi-model-fallback/run.ts
 *   OPENAI_API_KEY=... GOOGLE_API_KEY=... deno run --allow-all recipes/multi-model-fallback/run.ts
 *
 * The first tier is pointed at an unreachable host on purpose, so the
 * fallback fires every run. Watch for the `falling back` warning.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
