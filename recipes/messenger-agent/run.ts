/**
 * Runner for the messenger-agent recipe. Same file on every runtime:
 *
 *   TELEGRAM_BOT_TOKEN=... EXA_API_KEY=... OPENAI_API_KEY=... pnpm tsx recipes/messenger-agent/run.ts
 *   ... bun recipes/messenger-agent/run.ts
 *   ... deno run --allow-all recipes/messenger-agent/run.ts
 *
 * Long-lived: it polls until Ctrl-C. One instance per bot token.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
