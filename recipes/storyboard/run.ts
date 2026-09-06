/**
 * Runner for the storyboard recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=sk-... pnpm tsx recipes/storyboard/run.ts
 *   OPENAI_API_KEY=sk-... bun recipes/storyboard/run.ts
 *   OPENAI_API_KEY=sk-... deno run --allow-all recipes/storyboard/run.ts
 *
 *   # Bigger panels, two re-render rounds for anything the critic rejects:
 *   ... run.ts --resolution 2K --rounds 2
 *
 *   # `provider:model` on either flag. The registry knows the base URL and
 *   # which env var holds the key:
 *   GOOGLE_API_KEY=... ANTHROPIC_API_KEY=... ... run.ts \
 *     --model=google:gemini-3.1-flash-image \
 *     --llm-model=anthropic:claude-sonnet-5
 *
 *   # Everything through one gateway, one key:
 *   LLM_API_KEY=... ... run.ts \
 *     --model=requesty:vertex/google/gemini-3.1-flash-image \
 *     --llm-model=requesty:google/gemini-3.8-flash
 *
 * Each run writes to `output/storyboard/<timestamp>/`, so runs accumulate
 * rather than overwrite. `--out` picks a different directory, and then
 * avoiding a collision is yours to do: a run never clears what is there.
 *
 * Cost note: four sheets plus eight panels is twelve images before any
 * re-render, and `gpt-image-2` bills image output per token. A 2K panel
 * costs roughly four times a 1K one, so start at 1K.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
