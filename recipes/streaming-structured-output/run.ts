/**
 * Runner for the streaming-structured-output recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/streaming-structured-output/run.ts
 *   OPENAI_API_KEY=... bun recipes/streaming-structured-output/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/streaming-structured-output/run.ts
 *
 *   # Any provider: the JSONL contract is in the prompt, not the wire.
 *   ANTHROPIC_API_KEY=... ... run.ts --model anthropic:claude-sonnet-4-5
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
