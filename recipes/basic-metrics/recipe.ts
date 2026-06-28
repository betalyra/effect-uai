/**
 * Streaming metrics. Generate one very long (~20 page) fantasy story in a
 * single model turn and attach the full metric suite to the token stream:
 * time-to-first-token, live throughput, per-turn token totals, and
 * time-to-completion. The story deltas flow through untouched; the runner
 * writes them to a file while logging only the metric samples.
 *
 * `recipe.ts` is the runtime-agnostic core: it builds the metered stream
 * against the generic `LanguageModel` tag, so the provider (here Gemini
 * Flash) is chosen by the Layer in `app.ts`. The meters are plain stream
 * operators stacked onto `streamTurn` via `Metrics.allMetrics`; nothing about
 * the generation changes when you add or drop a meter, and the story text is
 * never buffered for measurement.
 *
 * Throughput is reported in *tokens* per second. The library ships no
 * tokenizer, and a live rate cannot use the provider's authoritative count
 * (that only lands at `TurnComplete`), so we estimate with the common rule of
 * thumb 4 characters ~= 1 token. Swap in a real tokenizer (for example
 * `@huggingface/transformers`) as the `tokenizer` for exact live tokens.
 */
import { Effect, Stream } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as Metrics from "@effect-uai/core/Metrics"
import type { TurnEvent } from "@effect-uai/core/Turn"

const SYSTEM_PROMPT = [
  "You are a master fantasy novelist.",
  "Write a single, complete, immersive fantasy story of roughly twenty pages.",
  "Use vivid prose, a clear arc (setup, rising action, climax, resolution), and",
  "chapter headings. Write the story and nothing else: no preamble, no notes,",
  "no word counts, no meta commentary.",
].join(" ")

/**
 * Rough live-token estimate: ~4 characters per token. `throughput` only calls
 * this for `TextDelta`s (the assistant's output text), but we guard anyway so
 * the estimator is total over `TurnEvent`.
 */
const estimateTokens = (event: TurnEvent): Effect.Effect<number> =>
  Effect.succeed(event._tag === "TextDelta" ? [...event.text].length / 4 : 0)

export type FantasyStoryConfig = {
  readonly model: string
  readonly prompt: string
  readonly maxOutputTokens: number
}

/**
 * One long generation, metered. Emits the provider's `TurnEvent`s (the story
 * deltas) interleaved with `MetricEvent`s at their own cadences. `allMetrics`
 * stacks `timeToFirstToken` (eager), `throughput` (every second, in estimated
 * tokens), and `tokenTotals` + `timeToCompletion` (at `TurnComplete`).
 */
export const fantasyStory = (
  cfg: FantasyStoryConfig,
): Stream.Stream<TurnEvent | Metrics.MetricEvent, AiError.AiError, LanguageModel.LanguageModel> =>
  LanguageModel.streamTurn({
    model: cfg.model,
    history: [Items.systemText(SYSTEM_PROMPT), Items.userText(cfg.prompt)],
    maxOutputTokens: cfg.maxOutputTokens,
  }).pipe(
    Metrics.allMetrics({
      throughput: { every: "1 second", unit: "token", tokenizer: estimateTokens },
    }),
  )
