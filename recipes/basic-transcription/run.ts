/**
 * Runner for the basic-transcription recipe. Same file on every runtime:
 *
 *   OPENAI_API_KEY=... pnpm tsx recipes/basic-transcription/run.ts talk.mp3
 *   OPENAI_API_KEY=... bun recipes/basic-transcription/run.ts talk.mp3
 *   OPENAI_API_KEY=... deno run --allow-all recipes/basic-transcription/run.ts talk.mp3
 *
 *   # Another provider's fast model:
 *   ELEVENLABS_API_KEY=... ... run.ts --provider elevenlabs talk.mp3
 *
 * Audio formats: m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm, flac.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
