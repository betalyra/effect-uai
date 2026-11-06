/**
 * Runner for the direct-chat recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/direct-chat/run.ts
 *   OPENAI_API_KEY=... bun recipes/direct-chat/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/direct-chat/run.ts
 *
 * Serves on http://localhost:3000 (`PORT` moves it). See README.md for curl.
 */
import { serveRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

serveRecipe(main)
