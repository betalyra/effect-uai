/**
 * Runner for the realtime-voice-agent recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... EXA_API_KEY=... pnpm tsx recipes/realtime-voice-agent/run.ts
 *   OPENAI_API_KEY=... bun recipes/realtime-voice-agent/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/realtime-voice-agent/run.ts
 *
 * Then open http://localhost:3000 (`PORT` moves it) and allow the microphone.
 */
import { serveRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

serveRecipe(main)
