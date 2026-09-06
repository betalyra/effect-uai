/**
 * Runner for the native-grounding recipe. Same file on every runtime:
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/native-grounding/run.ts
 *   GOOGLE_API_KEY=... bun recipes/native-grounding/run.ts
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/native-grounding/run.ts
 *
 *   # Another provider's hosted search, another question:
 *   ANTHROPIC_API_KEY=... ... run.ts --provider anthropic --question "..."
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
