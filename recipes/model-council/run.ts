/**
 * Runner for the model-council recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... GOOGLE_API_KEY=... ANTHROPIC_API_KEY=... \
 *     pnpm tsx recipes/model-council/run.ts
 *   ... bun recipes/model-council/run.ts
 *   ... deno run --allow-all recipes/model-council/run.ts
 *
 *   # Ask something else:
 *   ... run.ts --question "..."
 *
 * All three keys are needed: the point is the disagreement between them.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
