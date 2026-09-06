/**
 * Runner for the deep-research recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... pnpm tsx recipes/deep-research/run.ts
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... bun recipes/deep-research/run.ts
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... deno run --allow-all recipes/deep-research/run.ts
 *
 *   # Another model, another search backend, a wider plan:
 *   GOOGLE_API_KEY=... EXA_API_KEY=... ... run.ts \
 *     --model google:gemini-2.5-flash --search exa --sub-questions 6
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
