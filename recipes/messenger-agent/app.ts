/**
 * Wiring for the messenger-agent recipe: flags, the Telegram layer, a
 * language model and a web search provider. The recipe is `recipe.ts`.
 *
 *   TELEGRAM_BOT_TOKEN=... EXA_API_KEY=... OPENAI_API_KEY=... \
 *     pnpm tsx recipes/messenger-agent/run.ts [--model provider:model] [--search exa]
 */
import { Config, Effect, Layer, Option, Stdio } from "effect"
import { layer as telegramLayer } from "@effect-uai/telegram/Telegram"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec, webSearchLayer } from "../_shared/model.js"
import { betty, router } from "./recipe.js"

export const main = Effect.gen(function* () {
  const argv = yield* Effect.flatMap(Stdio.Stdio, (stdio) => stdio.args)
  const model = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => "gpt-5.4-mini"),
    "openai",
  )
  const search = Option.getOrElse(flagValue("search", argv), () => "exa")
  // For a gateway the registry has no base URL for, or a region-specific one
  // (`--base-url=https://router.eu.requesty.ai/v1`).
  const baseUrl = Option.getOrUndefined(flagValue("base-url", argv))
  const token = yield* Config.redacted("TELEGRAM_BOT_TOKEN")

  yield* Effect.log(`messenger-agent: polling Telegram, model ${model.provider}:${model.model}`)
  yield* router({ ...betty, model: model.model }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        telegramLayer({ token }),
        languageModelLayer(model, baseUrl),
        webSearchLayer(search),
      ),
    ),
  )
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
