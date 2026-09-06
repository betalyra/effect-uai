/**
 * Runner for the market-intel recipe. Same file on every runtime:
 *
 *   FIRECRAWL_API_KEY=... GOOGLE_API_KEY=... pnpm tsx recipes/market-intel/run.ts
 *   FIRECRAWL_API_KEY=... GOOGLE_API_KEY=... bun recipes/market-intel/run.ts
 *   FIRECRAWL_API_KEY=... GOOGLE_API_KEY=... deno run --allow-all recipes/market-intel/run.ts
 *
 *   # Another page reader, your own pages:
 *   JINA_API_KEY=... GOOGLE_API_KEY=... ... run.ts \
 *     --read jina --urls https://a.com/pricing,https://b.com/pricing
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
