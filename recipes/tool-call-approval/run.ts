/**
 * Runner for the tool-call-approval recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/tool-call-approval/run.ts
 *   OPENAI_API_KEY=... bun recipes/tool-call-approval/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/tool-call-approval/run.ts
 *
 * Verdicts are decided by the demo policy in `recipe.ts`, so the run needs no
 * input: watch the sensitive calls pause and then resolve.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
