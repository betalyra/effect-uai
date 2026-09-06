/**
 * Runner for the basic-music-generation recipe. Same file on every runtime:
 *
 *   ELEVENLABS_API_KEY=... pnpm tsx recipes/basic-music-generation/run.ts
 *   ELEVENLABS_API_KEY=... bun recipes/basic-music-generation/run.ts
 *   ELEVENLABS_API_KEY=... deno run --allow-all recipes/basic-music-generation/run.ts
 *
 *   # Lyria instead, with your own brief:
 *   GOOGLE_API_KEY=... ... run.ts --provider google \
 *     --prompt-file recipes/basic-music-generation/astronaut-coffee-break.txt
 *
 * Audio lands in `output/basic-music-generation/<timestamp>/track.mp3`.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
