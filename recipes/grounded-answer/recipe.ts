/**
 * Grounded answer (streaming). Answer a (current-events) question by letting
 * the model drive `webSearchTool`: it searches the web, reads the results,
 * searches again if it needs to, then writes an answer with inline source
 * links. The answer streams token-by-token as the model writes it.
 *
 * The point of the recipe is portability on two axes at once. The model
 * runs against the generic `LanguageModel` tag and the tool runs against
 * the generic `WebSearch` tag, so neither the program nor the model-facing
 * tool contract changes when you swap the LLM (OpenAI / Gemini) or the
 * search backend (Perplexity / Exa / Tavily / ...). The Layer at the bottom
 * decides who answers.
 *
 * Shape: an explicit streaming `Loop` (the same machinery as
 * `basic-usage` / `agentic-loop`). Each iteration streams a model turn;
 * `onTurnComplete` inspects it. If the model called `web_search`, the tool
 * runs, its results are fed back, and the loop continues. If the model
 * answered, the loop stops. A round cap withholds the tools on the final
 * turn, forcing an answer so the agent always terminates. The recipe yields
 * a `Stream` of turn / tool events; the runner forwards the text deltas to
 * stdout live.
 *
 * `recipe.ts` is the runtime-agnostic logic; `app.ts` wires providers and
 * the runners (`run-node.ts`, ...) supply the platform HttpClient.
 */
import { Effect, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { webSearchTool } from "@effect-uai/core/WebSearchTool"

// Citation-grounding prompt rules (see this recipe's README for the why):
// answer only from results, allow an honest "couldn't confirm", cite inline
// per claim, and demonstrate the exact link format for smaller models.
const SYSTEM_PROMPT = [
  "You are a research assistant. Use the web_search tool to find current information.",
  "",
  "- Answer ONLY from the search results. Do not use prior knowledge for facts.",
  "- You may search more than once to fill gaps, then answer.",
  "- Cite every factual claim inline with its source as a markdown link,",
  "  e.g. The model ships in March [source](https://example.com).",
  "- If the results do not support an answer, say so plainly instead of guessing.",
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

type State = {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly round: number
}

export const groundedAnswer = (cfg: GroundedAnswerConfig) => {
  const maxRounds = cfg.maxRounds ?? 5
  const tools = [webSearchTool({ maxResults: cfg.maxResults ?? 5 })]
  const descriptors = Tool.toDescriptors(tools)

  const initial: State = {
    history: [Items.systemText(SYSTEM_PROMPT), Items.userText(cfg.question)],
    round: 0,
  }

  return pipe(
    initial,
    loop((state: State) => {
      // On the last allowed round, withhold the tools so the model must
      // answer with what it gathered rather than search forever.
      const lastRound = state.round >= maxRounds
      return streamTurn({
        history: state.history,
        model: cfg.model,
        ...(lastRound ? {} : { tools: descriptors }),
      }).pipe(
        onTurnComplete((turn) =>
          Effect.sync(() => {
            const calls = lastRound ? [] : Turn.getToolCalls(turn)

            // No tool calls - the assistant is done.
            if (calls.length === 0) return stop()

            // Tool calls: stream tool events to the consumer, then continue
            // the loop with the appended turn + results.
            return Toolkit.run(tools, calls).pipe(
              Toolkit.continueWithResults(
                Toolkit.appendToolResults({ ...state, round: state.round + 1 }, turn),
              ),
            )
          }),
        ),
      )
    }),
  )
}
