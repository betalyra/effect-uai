/**
 * Wiring for the messenger-agent recipe: flags, the Telegram layer, a
 * language model, and the optional tools. The recipe is `recipe.ts`.
 *
 *   TELEGRAM_BOT_TOKEN=... OPENAI_API_KEY=... EXA_API_KEY=... \
 *     pnpm tsx recipes/messenger-agent/run.ts \
 *       [--model provider:model] [--search exa] [--image openai:gpt-image-2]
 *
 * `--search` and `--image` each bring a tool and its layer together: leave
 * one out and the model is never offered it.
 */
import { Array as Arr, Config, Effect, Layer, Option, Stdio } from "effect"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { layer as telegramLayer } from "@effect-uai/telegram/Telegram"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import {
  imageGeneratorLayer,
  languageModelLayer,
  parseModelSpec,
  webSearchLayer,
} from "../_shared/model.js"
import { betty, imageTool, router, searchTool } from "./recipe.js"

export const main = Effect.gen(function* () {
  const argv = yield* Effect.flatMap(Stdio.Stdio, (stdio) => stdio.args)
  const model = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => "gpt-5.4-mini"),
    "openai",
  )
  // The language model's gateway only, for one the registry has no base URL
  // for or a region-specific one (`--base-url=https://router.eu.requesty.ai/v1`).
  const baseUrl = Option.getOrUndefined(flagValue("base-url", argv))
  const token = yield* Config.redacted("TELEGRAM_BOT_TOKEN")

  const search = Option.map(flagValue("search", argv), (provider) => ({
    tool: searchTool,
    layer: webSearchLayer(provider),
  }))
  const image = Option.map(flagValue("image", argv), (spec) => {
    const drawing = parseModelSpec(spec, "openai")
    return { tool: imageTool(drawing.model), layer: imageGeneratorLayer(drawing) }
  })
  const configured = Arr.getSomes([search, image])
  const tools = configured.map((c) => c.tool.name).join(", ") || "none"

  yield* Effect.log(`messenger-agent: model ${model.provider}:${model.model}, tools ${tools}`)
  yield* router({
    ...betty,
    model: model.model,
    toolkit: Toolkit.fromArray(configured.map((c) => c.tool)),
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        telegramLayer({ token }),
        languageModelLayer(model, baseUrl),
        ...configured.map((c) => c.layer),
      ),
    ),
  )
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
