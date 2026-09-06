/**
 * Runner for the streaming-transcription recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/streaming-transcription/run.ts
 *   OPENAI_API_KEY=... bun recipes/streaming-transcription/run.ts
 *   OPENAI_API_KEY=... deno run --allow-all recipes/streaming-transcription/run.ts
 *
 *   # Another realtime STT socket:
 *   ELEVENLABS_API_KEY=... ... run.ts --provider elevenlabs
 *
 * Then open http://localhost:3000 (`PORT` moves it) and allow the microphone.
 */
import { serveRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

serveRecipe(main)
