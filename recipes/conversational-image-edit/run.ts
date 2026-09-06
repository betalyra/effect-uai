/**
 * Runner for the conversational-image-edit recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=sk-... pnpm tsx recipes/conversational-image-edit/run.ts
 *   OPENAI_API_KEY=sk-... bun recipes/conversational-image-edit/run.ts
 *   OPENAI_API_KEY=sk-... deno run --allow-all recipes/conversational-image-edit/run.ts
 *
 *   # Through a gateway on one key, or on another provider:
 *   LLM_API_KEY=... ... run.ts --model=requesty:azure/openai/gpt-image-2
 *
 *   # More preview frames per turn, bigger output:
 *   ... run.ts --previews 3 --resolution 2K
 *
 * Previews are drawn inline in iTerm2, kitty, WezTerm, Ghostty, and in
 * VS Code's terminal with `terminal.integrated.enableImages` on. Anywhere
 * else the finished frames still land in `output/`.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
