/**
 * Runner for the tv-station recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... FAL_API_KEY=... bun recipes/tv-station/run.ts
 *   OPENAI_API_KEY=... FAL_API_KEY=... pnpm tsx recipes/tv-station/run.ts
 *
 *   # follow a brief, research it first, and keep it playing:
 *   ... run.ts --brief-file brief.md --search --loop
 *
 * Then open http://localhost:3000 and press Play. Nothing is generated
 * until you do. Clips and the station manifest land under
 * `output/tv-station/cache/<provider>/`, and a restart picks up from
 * there, including a clip still rendering on the provider.
 */
import { serveRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

serveRecipe(main)
