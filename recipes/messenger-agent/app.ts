/**
 * Wiring for the messenger-agent recipe: flags, a messenger layer, a
 * language model, and the optional tools. The recipe is `recipe.ts`.
 *
 *   TELEGRAM_BOT_TOKEN=... OPENAI_API_KEY=... EXA_API_KEY=... \
 *     pnpm tsx recipes/messenger-agent/run.ts \
 *       [--messenger telegram|discord] [--model provider:model] \
 *       [--search exa] [--image openai:gpt-image-2] [--read-all]
 *
 * `--search` and `--image` each bring a tool and its layer together: leave
 * one out and the model is never offered it. `--read-all` asks Discord for
 * the privileged Message Content intent, which the developer portal must
 * grant first; without it only DMs and mentions carry any text.
 */
import { Array as Arr, Config, Effect, Layer, Match, Option, Stdio } from "effect"
import type { HttpClient } from "effect/unstable/http"
import * as Toolkit from "@effect-uai/core/Toolkit"
import type { Messenger } from "@effect-uai/core/Messenger"
import { type MessengerConnectFailed, describe } from "@effect-uai/core/MessengerError"
import { Intents, defaultIntents, layer as discordLayer } from "@effect-uai/discord/Discord"
import { layer as telegramLayer } from "@effect-uai/telegram/Telegram"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import {
  UnknownProvider,
  imageGeneratorLayer,
  languageModelLayer,
  parseModelSpec,
  webSearchLayer,
} from "../_shared/model.js"
import { type Markup, betty, imageTool, router, searchTool } from "./recipe.js"

type Wiring = {
  /** Layer for the chosen platform. Only its own token is read. */
  readonly layer: Layer.Layer<Messenger, MessengerConnectFailed, HttpClient.HttpClient>
  /** What the layer sends text as, and so what the prompt must ask for. */
  readonly markup: Markup
}

/**
 * One entry per platform: its token, its layer, and the markup it reads.
 * `readAll` widens what the bot may see, which each platform gates its own
 * way: Discord behind the privileged Message Content intent, Telegram behind
 * BotFather's privacy setting, which is why only Discord reads it here.
 */
const platforms: Record<string, (readAll: boolean) => Effect.Effect<Wiring, Config.ConfigError>> = {
  telegram: () =>
    Effect.map(Config.redacted("TELEGRAM_BOT_TOKEN"), (token) => ({
      layer: telegramLayer({ token }),
      markup: "html",
    })),
  discord: (readAll) =>
    Effect.map(Config.redacted("DISCORD_BOT_TOKEN"), (token) => ({
      layer: discordLayer({
        token,
        ...(readAll && { intents: defaultIntents | Intents.MessageContent }),
      }),
      markup: "markdown",
    })),
}

const wire = (
  platform: string,
  readAll: boolean,
): Effect.Effect<Wiring, Config.ConfigError | UnknownProvider> =>
  platforms[platform]?.(readAll) ??
  Effect.fail(
    new UnknownProvider({
      spec: platform,
      provider: platform,
      expected: Object.keys(platforms).join(" | "),
    }),
  )

export const main = Effect.gen(function* () {
  const argv = yield* Effect.flatMap(Stdio.Stdio, (stdio) => stdio.args)
  const model = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => "gpt-5.4-mini"),
    "openai",
  )
  // The language model's gateway only, for one the registry has no base URL
  // for or a region-specific one (`--base-url=https://router.eu.requesty.ai/v1`).
  const baseUrl = Option.getOrUndefined(flagValue("base-url", argv))
  const platform = Option.getOrElse(flagValue("messenger", argv), () => "telegram")
  const { layer: messenger, markup } = yield* wire(platform, argv.includes("--read-all"))

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

  yield* Effect.log(
    `messenger-agent: ${platform}, model ${model.provider}:${model.model}, tools ${tools}`,
  )
  yield* router({
    ...betty(markup),
    model: model.model,
    toolkit: Toolkit.fromArray(configured.map((c) => c.tool)),
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        messenger,
        languageModelLayer(model, baseUrl),
        ...configured.map((c) => c.layer),
      ),
    ),
  )
}).pipe(
  // A refused token or an intent the portal has not granted is the one failure
  // worth spelling out: `Cause.pretty` would print the tag alone.
  Effect.tapErrorTag("MessengerConnectFailed", (e) => Effect.logError(describe(e))),
  Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })),
)
