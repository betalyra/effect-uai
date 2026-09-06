/**
 * Runner for the sleeper-agent recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/sleeper-agent/run.ts
 *   OPENAI_API_KEY=... bun recipes/sleeper-agent/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/sleeper-agent/run.ts
 *
 * The CI pipeline is simulated, so no external service is needed. Watch the
 * `[poll]` lines tick by between the two model turns.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
