/**
 * Runner for the native-deep-research recipe. Same file on every runtime:
 *
 *   PERPLEXITY_API_KEY=... pnpm tsx recipes/native-deep-research/run.ts
 *   PERPLEXITY_API_KEY=... bun recipes/native-deep-research/run.ts
 *   PERPLEXITY_API_KEY=... deno run --allow-all recipes/native-deep-research/run.ts
 *
 *   # Another provider's hosted job, another question:
 *   OPENAI_API_KEY=... ... run.ts --provider openai --question "..."
 *
 * Expect minutes, not seconds: the job runs server-side and the stream
 * reports progress until it finishes.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
