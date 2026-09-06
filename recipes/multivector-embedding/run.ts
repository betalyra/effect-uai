/**
 * Runner for the multivector-embedding recipe. Same file on every runtime:
 *
 *   JINA_API_KEY=... pnpm tsx recipes/multivector-embedding/run.ts
 *   JINA_API_KEY=... bun recipes/multivector-embedding/run.ts
 *   JINA_API_KEY=... deno run --allow-all recipes/multivector-embedding/run.ts
 *
 * Late interaction is a Jina v4 feature, so `--model` stays on that family.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
