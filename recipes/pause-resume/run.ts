/**
 * Runner for the pause-resume recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/pause-resume/run.ts
 *   OPENAI_API_KEY=... bun recipes/pause-resume/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/pause-resume/run.ts
 *
 *   # Pause earlier, for less time:
 *   ... run.ts --pause-after 1 --pause-for "5 seconds"
 *
 * While paused, no HTTP connection is held open: the loop simply has not
 * started the next turn yet.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
