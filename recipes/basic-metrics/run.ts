/**
 * Runner for the basic-metrics recipe. Same file on every runtime:
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/basic-metrics/run.ts
 *   GOOGLE_API_KEY=... bun recipes/basic-metrics/run.ts
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/basic-metrics/run.ts
 *
 *   # Another provider, a shorter run:
 *   OPENAI_API_KEY=... ... run.ts --model openai:gpt-5.2 --max-tokens 4096
 *
 * The story lands in `output/basic-metrics/<timestamp>/story.txt`; only the
 * metric samples go to the console.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
