/**
 * Runner for the ticket-triage recipe. Same file on every runtime:
 *
 *   TYPESAFE_AI_API_KEY=... pnpm tsx recipes/ticket-triage/run.ts
 *   TYPESAFE_AI_API_KEY=... bun recipes/ticket-triage/run.ts
 *   TYPESAFE_AI_API_KEY=... deno run --allow-all recipes/ticket-triage/run.ts
 *
 *   # Pin a version:
 *   ... run.ts --model typesafe:jev-1.13.0
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
