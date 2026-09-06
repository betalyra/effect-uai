/**
 * Runner for the dashboard-briefing recipe. Same file on every runtime:
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/dashboard-briefing/run.ts
 *   GOOGLE_API_KEY=... bun recipes/dashboard-briefing/run.ts
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/dashboard-briefing/run.ts
 *
 *   # Your own dashboard, more time for the charts to draw:
 *   ... run.ts --url https://example.com/metrics --settle "5 seconds"
 *
 * Needs a Chromium with its DevTools port open. Locally:
 *   docker run -d --name chromium -p 127.0.0.1:9222:9222 chromedp/headless-shell
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
