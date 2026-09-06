/**
 * Runner for the multimodal-embedding recipe. Same file on every runtime:
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/multimodal-embedding/run.ts
 *   GOOGLE_API_KEY=... bun recipes/multimodal-embedding/run.ts
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/multimodal-embedding/run.ts
 *
 * The images are fetched from Unsplash at run time, so this one needs
 * network access beyond the provider itself.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
