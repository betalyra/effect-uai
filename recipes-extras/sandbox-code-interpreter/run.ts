/**
 * Runner for the sandbox-code-interpreter recipe. Same file on every runtime:
 *
 *   pnpm -C recipes-extras/sandbox-code-interpreter install
 *   ANTHROPIC_API_KEY=... pnpm -C recipes-extras/sandbox-code-interpreter start
 *
 *   # Another provider driving the same microVM:
 *   OPENAI_API_KEY=... pnpm -C recipes-extras/sandbox-code-interpreter start -- --provider openai
 *
 * Needs a running Microsandbox server: the model's code executes in a
 * microVM, not in this process.
 */
import { runRecipe } from "@effect-uai/recipe-kit/runtime"
import { main } from "./app.js"

runRecipe(main)
