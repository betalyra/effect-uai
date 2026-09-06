/**
 * Runner for the agentic-loop recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/agentic-loop/run.ts
 *   OPENAI_API_KEY=... bun recipes/agentic-loop/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/agentic-loop/run.ts
 *
 *   # Any other provider the registry knows:
 *   ANTHROPIC_API_KEY=... ... run.ts --model anthropic:claude-sonnet-5
 *
 * Interactive: type at the `you>` prompt, Ctrl-C to exit.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
