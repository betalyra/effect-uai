/**
 * Node runner for the conversational-image-edit recipe.
 *
 *   OPENAI_API_KEY=sk-... pnpm tsx recipes/conversational-image-edit/run-node.ts
 *
 *   # Through a gateway on one key, or on another provider:
 *   LLM_API_KEY=... ... run-node.ts --model=requesty:azure/openai/gpt-image-2
 *
 *   # More preview frames per turn, bigger output:
 *   ... run-node.ts --previews 3 --resolution 2K
 *
 * Previews are drawn inline in iTerm2, kitty, WezTerm, Ghostty, and in
 * VS Code's terminal with `terminal.integrated.enableImages` on. Anywhere
 * else the finished frames still land in `output/`.
 */
import { Effect, Layer } from "effect"
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { appLayer, main } from "./app.js"

const platformLayer = Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(appLayer.pipe(Layer.provideMerge(platformLayer)))))
