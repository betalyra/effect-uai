/**
 * Runner for the streaming-tool-output recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/streaming-tool-output/run.ts
 *   OPENAI_API_KEY=... bun recipes/streaming-tool-output/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/streaming-tool-output/run.ts
 *
 * The download is simulated, so nothing is fetched over the network beyond
 * the model call itself.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
