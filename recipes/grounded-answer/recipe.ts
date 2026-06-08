/**
 * Grounded answer. Answer a (current-events) question by letting the model
 * drive `webSearchTool`: it searches the web, reads the results, searches
 * again if it needs to, then writes an answer with inline source links.
 *
 * The point of the recipe is portability on two axes at once. The model
 * runs against the generic `LanguageModel` tag and the tool runs against
 * the generic `WebSearch` tag, so neither the program nor the model-facing
 * tool contract changes when you swap the LLM (OpenAI / Gemini) or the
 * search backend (Perplexity / Exa / ...). The Layer at the bottom decides
 * who answers.
 *
 * Shape: a plain `Effect` that runs the tool loop to completion and returns
 * the final answer text plus how many search rounds it took. No streaming,
 * no Queue - the model either calls `web_search` and we feed results back,
 * or it answers and we stop. A round cap forces a final, tool-free turn so
 * the agent always terminates with an answer instead of looping.
 *
 * `recipe.ts` is the runtime-agnostic logic; `app.ts` wires providers and
 * the runners (`run-node.ts`, ...) supply the platform HttpClient.
 */
import { Effect } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel, turn } from "@effect-uai/core/LanguageModel"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import type { WebSearch } from "@effect-uai/core/WebSearch"
import { webSearchTool } from "@effect-uai/core/WebSearchTool"

const SYSTEM_PROMPT = [
  "You are a research assistant. Answer the user's question using the web_search tool to find current information.",
  "",
  "Rules:",
  "- Search before answering anything time-sensitive; do not rely on prior knowledge for current facts.",
  "- You may search more than once to fill gaps, then answer.",
  "- Cite every factual claim inline with its source as a markdown link, e.g. [source](https://example.com).",
  "- If the searches do not support an answer, say so plainly instead of guessing.",
].join("\n")

export type GroundedAnswerConfig = {
  readonly question: string
  /** Model id for the generic `LanguageModel` (provider chosen by the Layer). */
  readonly model: string
  /**
   * Hard cap on model turns. On the final round the model is given no
   * tools, forcing it to answer with what it has - so the agent always
   * terminates. Default `5`.
   */
  readonly maxRounds?: number
  /** App-fixed result ceiling per search. Default `5`. */
  readonly maxResults?: number
}

export type GroundedAnswer = {
  /** Final answer text, with inline citation links. */
  readonly answer: string
  /** How many tool-driven search rounds the model ran before answering. */
  readonly rounds: number
}

export const groundedAnswer = (
  cfg: GroundedAnswerConfig,
): Effect.Effect<GroundedAnswer, AiError.AiError, LanguageModel | WebSearch> => {
  const maxRounds = cfg.maxRounds ?? 5
  const tools = [webSearchTool({ maxResults: cfg.maxResults ?? 5 })] as const
  const descriptors = Tool.toDescriptors(tools)

  const run = (
    history: ReadonlyArray<Items.HistoryItem>,
    round: number,
  ): Effect.Effect<GroundedAnswer, AiError.AiError, LanguageModel | WebSearch> =>
    Effect.gen(function* () {
      // On the last allowed round, withhold the tools so the model must
      // answer with what it already gathered rather than search forever.
      const lastRound = round >= maxRounds
      const result = yield* turn({
        history,
        model: cfg.model,
        ...(lastRound ? {} : { tools: descriptors }),
      })

      const calls = lastRound ? [] : Turn.getToolCalls(result)
      if (calls.length === 0) {
        return { answer: Turn.assistantText(result), rounds: round }
      }

      const results = yield* Toolkit.collectResults(Toolkit.run(tools, calls))
      const next = Toolkit.appendToolResults({ history }, result)(results)
      return yield* run(next.history, round + 1)
    })

  return run([Items.systemText(SYSTEM_PROMPT), Items.userText(cfg.question)], 0)
}
