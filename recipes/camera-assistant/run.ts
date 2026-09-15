/**
 * Runner for the camera-assistant recipe. Same file on every runtime:
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/camera-assistant/run.ts
 *   GOOGLE_API_KEY=... bun recipes/camera-assistant/run.ts
 *   GOOGLE_API_KEY=... deno run --allow-all recipes/camera-assistant/run.ts
 *
 * Then open http://localhost:3000 (`PORT` moves it), allow the microphone,
 * and switch the camera on when you want it to see something.
 */
import { serveRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

serveRecipe(main)
