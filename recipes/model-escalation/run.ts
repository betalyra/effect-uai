/**
 * Runner for the model-escalation recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/model-escalation/run.ts
 *   OPENAI_API_KEY=... bun recipes/model-escalation/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/model-escalation/run.ts
 *
 *   # Another provider's cheap/strong pair:
 *   ANTHROPIC_API_KEY=... ... run.ts --provider anthropic
 *
 * Interactive. Try one easy and one hard question in the same session:
 *   you> What's the capital of Portugal?
 *   you> Why does a quantum harmonic oscillator have non-zero ground-state energy?
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
