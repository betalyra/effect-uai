/**
 * Composition for the messenger-agent recipe: a Telegram bot with web
 * search. `TELEGRAM_BOT_TOKEN` and a search provider key are the only
 * platform-specific lines; everything else is the router and the loop.
 *
 *   TELEGRAM_BOT_TOKEN=... EXA_API_KEY=... OPENAI_API_KEY=... \
 *     pnpm tsx recipes/messenger-agent/run.ts [--model provider:model] [--search exa]
 *
 * The system prompt asks for Telegram HTML because that is what the wired
 * layer sends verbatim (`parseMode: "HTML"`). On another platform that one
 * line changes; the recipe does not.
 */
import { Config, Effect, Layer, Option, Stdio } from "effect"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { webSearchTool } from "@effect-uai/core/WebSearchTool"
import { layer as telegramLayer } from "@effect-uai/telegram/Telegram"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec, webSearchLayer } from "../_shared/model.js"
import { router } from "./recipe.js"

const system = [
  "You are Betty, a helpful agent built with effect-uai, the Effect library for AI agents.",
  "When someone asks who or what you are, say you are Betty, built with effect-uai, and link",
  '<a href="https://effect-uai.betalyra.com">effect-uai.betalyra.com</a>. Never call yourself a',
  "generic assistant, and never mention Telegram, chats, bots or how you are hosted.",
  "Keep answers short and warm.",
  "Format replies as Telegram HTML: <b>, <i>, <code>, <pre>, <a href>. Escape & < > in prose.",
  "Never use markdown asterisks or backticks.",
].join(" ")

const greeting = "Hi, I'm <b>Betty</b> 👋"

const toolkit = Toolkit.make(webSearchTool({ maxResults: 5 }))

export const main = Effect.gen(function* () {
  const argv = yield* Effect.flatMap(Stdio.Stdio, (stdio) => stdio.args)
  const model = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => "gpt-5.4-mini"),
    "openai",
  )
  const search = Option.getOrElse(flagValue("search", argv), () => "exa")
  // Escape hatch for a gateway the registry has no base URL for, or a
  // region-specific one (`--base-url=https://router.eu.requesty.ai/v1`).
  const baseUrl = Option.getOrUndefined(flagValue("base-url", argv))
  const token = yield* Config.redacted("TELEGRAM_BOT_TOKEN")

  yield* Effect.log(`messenger-agent: polling Telegram, model ${model.provider}:${model.model}`)
  yield* router({ model: model.model, toolkit, system, greeting }).pipe(
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
