/**
 * Runner for the voice-loop recipe. Same file on every runtime:
 *
 *   ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... pnpm tsx recipes/voice-loop/run.ts
 *   ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... bun recipes/voice-loop/run.ts
 *   ELEVENLABS_API_KEY=... GOOGLE_API_KEY=... deno run --allow-all recipes/voice-loop/run.ts
 *
 *   # All-Mistral stack (Voxtral STT/TTS + Mistral LLM), with frame logging:
 *   MISTRAL_API_KEY=... ... run.ts --provider mistral --debug
 *
 * Then open http://localhost:3000 (`PORT` moves it) and allow the microphone.
 */
import { serveRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

serveRecipe(main)
