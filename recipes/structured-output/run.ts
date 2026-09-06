/**
 * Runner for the structured-output recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/structured-output/run.ts
 *   OPENAI_API_KEY=... bun recipes/structured-output/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/structured-output/run.ts
 *
 *   # Any provider that enforces a JSON schema server-side:
 *   ANTHROPIC_API_KEY=... ... run.ts --model anthropic:claude-sonnet-4-5
 *   GOOGLE_API_KEY=...    ... run.ts --model google:gemini-2.5-flash
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
