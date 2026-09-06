/**
 * Runner for the grounded-answer recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... pnpm tsx recipes/grounded-answer/run.ts
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... bun recipes/grounded-answer/run.ts
 *   OPENAI_API_KEY=... PERPLEXITY_API_KEY=... deno run --allow-all recipes/grounded-answer/run.ts
 *
 *   # Another model, another search backend, your own question:
 *   GOOGLE_API_KEY=... TAVILY_API_KEY=... ... run.ts \
 *     --model google:gemini-2.5-flash --search tavily --question "..."
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
