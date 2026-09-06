/**
 * Runner for the radio-station recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... ELEVENLABS_API_KEY=... pnpm tsx recipes/radio-station/run.ts
 *   OPENAI_API_KEY=... ELEVENLABS_API_KEY=... bun recipes/radio-station/run.ts
 *   OPENAI_API_KEY=... ELEVENLABS_API_KEY=... deno run --allow-all recipes/radio-station/run.ts
 *
 *   # Lyria instead, a different brief, a longer set:
 *   OPENAI_API_KEY=... GOOGLE_API_KEY=... ... run.ts \
 *     --music-model google:lyria-3-clip-preview --brief "..." --tracks 20
 *
 * Then open http://localhost:3000 (`PORT` moves it). Generated tracks are
 * cached under `output/radio-station/cache/<provider>/` and replayed from
 * there, so a second run costs nothing.
 */
import { serveRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

serveRecipe(main)
