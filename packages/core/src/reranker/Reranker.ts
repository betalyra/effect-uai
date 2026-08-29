import { Context, Effect } from "effect"
import type * as AiError from "../domain/AiError.js"

/**
 * Cross-provider rerank request. Vendor knobs (multimodal documents,
 * instruction fields, truncation) live on the provider's typed request.
 */
export type CommonRerankRequest = {
  readonly query: string
  readonly documents: ReadonlyArray<string>
  /** Each provider narrows this to its typed literal union. */
  readonly model: string
  /** Keep only the top N results. Default: all documents. */
  readonly topN?: number
}

export type RerankResult = {
  /** Position in the request's `documents`. */
  readonly index: number
  readonly score: number
}

/** Optional throughout: some providers bill per search unit, not per token. */
export type RerankUsage = {
  readonly totalTokens?: number
}

/**
 * Score contract: `results` is sorted descending, higher is better. Scores
 * order candidates within one call; no range or calibration is promised and
 * they are not comparable across requests. Implementors must sort descending
 * if the wire does not.
 */
export type RerankResponse = {
  readonly results: ReadonlyArray<RerankResult>
  readonly usage: RerankUsage
}

export type RerankerService = {
  readonly rerank: (request: CommonRerankRequest) => Effect.Effect<RerankResponse, AiError.AiError>
}

export class Reranker extends Context.Service<Reranker, RerankerService>()(
  "@betalyra/effect-uai/Reranker",
) {}

/** Score a candidate set against a query, best first. */
export const rerank = (
  request: CommonRerankRequest,
): Effect.Effect<RerankResponse, AiError.AiError, Reranker> =>
  Effect.flatMap(Reranker, (r) => r.rerank(request))
