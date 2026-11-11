/**
 * Runner for the basic-video-generation recipe. Same file on every runtime:
 *
 *   GOOGLE_API_KEY=... pnpm tsx recipes/basic-video-generation/run.ts
 *   GOOGLE_API_KEY=... bun recipes/basic-video-generation/run.ts
 *
 *   # fal instead (the model is the endpoint path):
 *   FAL_API_KEY=... ... run.ts --model fal:minimax/h3-max-turbo/text-to-video
 *
 *   # resume an interrupted run without paying twice:
 *   ... run.ts --ref output/basic-video-generation/<timestamp>/ref.json
 *
 * Clips land in `output/basic-video-generation/<timestamp>/clip-0.mp4`.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
