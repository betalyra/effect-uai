/**
 * Runner for the durable-chat recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/durable-chat/run.ts
 *   OPENAI_API_KEY=... bun recipes/durable-chat/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/durable-chat/run.ts
 *
 * Serves on http://localhost:3000 (`PORT` moves it). See README.md for curl.
 */
import { serveRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

serveRecipe(main)
