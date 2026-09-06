/**
 * Runner for the basic-speech-synthesis recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/basic-speech-synthesis/run.ts
 *   OPENAI_API_KEY=... bun recipes/basic-speech-synthesis/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/basic-speech-synthesis/run.ts
 *
 *   # Another voice stack, both synthesis modes:
 *   GOOGLE_API_KEY=... ... run.ts --provider google --mode both
 *
 * Audio lands in `output/basic-speech-synthesis/<timestamp>/`.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
