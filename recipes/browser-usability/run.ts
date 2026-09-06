/**
 * Runner for the browser-usability recipe. Same file on every runtime:
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/browser-usability/run.ts
 *   GOOGLE_API_KEY=... bun recipes/browser-usability/run.ts
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/browser-usability/run.ts
 *
 *   # Your own site and goal, against a hosted CDP endpoint:
 *   ... run.ts --url https://example.com --goal "..." --cdp ws://...
 *
 * Needs a Chromium with its DevTools port open. Locally:
 *   docker run -d --name chromium -p 127.0.0.1:9222:9222 chromedp/headless-shell
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
