/**
 * Native deep research. Ask one broad question and let the *provider* run the
 * whole multi-step research agent server-side (dozens of searches over minutes),
 * streaming what it does as it goes, then hand back one cited report. You make a
 * single call; there is no loop to drive and no search backend to wire.
 *
 * This is the provider-hosted counterpart to `deep-research`, which hand-rolls
 * the agent (`plan -> fanOut -> synthesize`) over the generic `LanguageModel` +
 * `WebSearch` tags. Here the agent lives inside the provider: `o3-deep-research`
 * (OpenAI) / `sonar-deep-research` (Perplexity) are background jobs the adapter
 * submits, streams, and polls to completion.
 *
 * The body is one `DeepResearch.researchStream` call: it submits the job and
 * forwards its progress as `TurnEvent`s, terminating in `TurnComplete` whose
 * `turn` carries the report text and citations. Running against the universal
 * generic tag keeps it portable: real events on providers that stream (OpenAI),
 * synthesized progress on poll-only ones (Perplexity), same body. `app.ts` picks
 * the provider Layer and renders the stream; the runners supply the HttpClient.
 */
import { researchStream } from "@effect-uai/core/DeepResearch"
import * as Items from "@effect-uai/core/Items"

export type NativeDeepResearchConfig = {
  readonly question: string
  /** Deep-research model id for the generic tag (provider chosen by the Layer). */
  readonly model?: string
}

export const nativeDeepResearch = (cfg: NativeDeepResearchConfig) =>
  researchStream({
    history: [Items.userText(cfg.question)],
    ...(cfg.model !== undefined && { model: cfg.model }),
  })
