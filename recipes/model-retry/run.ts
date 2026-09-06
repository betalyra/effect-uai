/**
 * Runner for the model-retry recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/model-retry/run.ts
 *   OPENAI_API_KEY=... bun recipes/model-retry/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/model-retry/run.ts
 *
 *   # Any other provider the registry knows:
 *   GOOGLE_API_KEY=... ... run.ts --model google:gemini-2.5-flash
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
