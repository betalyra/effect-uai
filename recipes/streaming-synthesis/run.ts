/**
 * Runner for the streaming-synthesis recipe. Same file on every runtime:
 *
 *   ELEVENLABS_API_KEY=... pnpm tsx recipes/streaming-synthesis/run.ts
 *   ELEVENLABS_API_KEY=... bun recipes/streaming-synthesis/run.ts
 *   ELEVENLABS_API_KEY=... deno run --allow-all recipes/streaming-synthesis/run.ts
 *
 *   # Inworld's incremental endpoint instead:
 *   INWORLD_API_KEY=... ... run.ts --provider inworld
 *
 * Then open http://localhost:3000 (`PORT` moves it) and type a sentence.
 */
import { serveRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

serveRecipe(main)
