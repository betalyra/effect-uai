/**
 * Runner for the multi-model-compare recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... GOOGLE_API_KEY=... ANTHROPIC_API_KEY=... \
 *     pnpm tsx recipes/multi-model-compare/run.ts
 *   ... bun recipes/multi-model-compare/run.ts
 *   ... deno run --allow-all recipes/multi-model-compare/run.ts
 *
 *   # Ask something else:
 *   ... run.ts --question "..."
 *
 * All three keys are needed: the point is the disagreement between them.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
