/**
 * Runner for the advanced-speech-synthesis recipe. Same file on every runtime:
 *
 *   ELEVENLABS_API_KEY=... pnpm tsx recipes/advanced-speech-synthesis/run.ts
 *   ELEVENLABS_API_KEY=... bun recipes/advanced-speech-synthesis/run.ts
 *   ELEVENLABS_API_KEY=... deno run --allow-all recipes/advanced-speech-synthesis/run.ts
 *
 *   # Chunked instead, or both:
 *   ... run.ts --mode dialogue-stream
 *   ... run.ts --mode both
 *
 * Audio lands in `output/advanced-speech-synthesis/<timestamp>/`.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
