/**
 * Native grounding. Ask a current-events question and let the *provider* ground
 * the answer with its own hosted web search — no local search backend to wire.
 * The provider runs the search server-side and returns a grounded answer with
 * citations already attached.
 *
 * This is the counterpart to `grounded-answer`, which wires a *local*
 * `webSearchTool` (Perplexity / Exa / Tavily) and drives it over the loop. The
 * machinery here is the same explicit streaming `Loop` as `basic-usage`: each
 * round streams a model turn and `onTurnComplete` inspects it. The difference
 * is who runs the search — the hosted tool executes inside the provider turn
 * and never shows up as a local tool call, so the loop simply stops once the
 * grounded answer arrives.
 *
 * The hosted tool is provider-specific (`Gemini.googleSearchTool` vs
 * `Anthropic.webSearchTool` vs `Responses.webSearchTool`), so `app.ts` picks it
 * per provider and hands it in as `searchTool`; `recipe.ts` stays generic and
 * runs against the `LanguageModel` tag. The runners supply the HttpClient.
 */
import { Effect, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import type * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

const SYSTEM_PROMPT = [
  "You are a research assistant with a hosted web search tool.",
  "Search the web to answer current-events questions, then write the answer",
  "with inline source links for every factual claim.",
].join("\n")

export type NativeGroundingConfig = {
  readonly question: string
  /** Model id for the generic `LanguageModel` (provider chosen by the Layer). */
  readonly model: string
  /**
   * The provider's hosted web search tool, chosen in `app.ts` so the
   * provider-specific constructor stays out of this generic body.
   */
  readonly searchTool: Tool.AnyTool
  /**
   * Hard cap on model turns. On the final round the tool is withheld so the
   * model answers with what it has and the loop always terminates. Default `3`.
   */
  readonly maxRounds?: number
}

type State = {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly round: number
}

export const nativeGrounding = (cfg: NativeGroundingConfig) => {
  const maxRounds = cfg.maxRounds ?? 3
  const toolkit = { [cfg.searchTool.name]: cfg.searchTool }

  const initial: State = {
    history: [Items.systemText(SYSTEM_PROMPT), Items.userText(cfg.question)],
    round: 0,
  }

  return pipe(
    initial,
    loop((state: State) => {
      const lastRound = state.round >= maxRounds
      return streamTurn({
        history: state.history,
        model: cfg.model,
        ...(lastRound ? {} : { tools: toolkit }),
      }).pipe(
        onTurnComplete((turn) =>
          Effect.sync(() => {
            // The hosted web search runs inside the provider turn — it never
            // appears as a local tool call — so a grounded answer just stops
            // the loop. (Local `Tool.make` tools, if you added any, would run
            // through `Toolkit.run` here and continue the loop.)
            const calls = lastRound ? [] : Turn.getToolCalls(turn)
            if (calls.length === 0) return stop()
            return Toolkit.run(toolkit, calls).pipe(
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
