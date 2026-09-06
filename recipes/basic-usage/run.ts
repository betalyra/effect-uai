/**
 * Runner for the basic-usage recipe. Same file on every runtime:
 *
 *   LLM_API_KEY=sk-or-... pnpm tsx recipes/basic-usage/run.ts
 *   LLM_API_KEY=sk-or-... bun recipes/basic-usage/run.ts
 *   LLM_API_KEY=sk-or-... deno run --allow-all recipes/basic-usage/run.ts
 *
 *   # Point at any OpenAI-compatible gateway / model via flags:
 *   LLM_API_KEY=... ... run.ts \
 *     --base-url https://router.requesty.ai/v1 --model moonshotai/kimi-k3 --provider requesty
 *
 * Everything not in this file is in `app.ts` (composition + rendering) and
 * `recipe.ts` (the agent loop).
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
