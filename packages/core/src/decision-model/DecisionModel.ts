import { Context, Effect } from "effect"
import type * as AiError from "../domain/AiError.js"
import type * as Decision from "./Decision.js"

/** Optional throughout: not every backing reports token counts. */
export type DecideUsage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export type DecideResponse<D extends Decision.Decisions = Decision.Decisions> = {
  readonly answers: Decision.Answers<D>
  readonly usage: DecideUsage
}

/**
 * Cross-provider decide request. The input is billed once for the whole
 * definition, so batching decisions is cheaper than repeating the input.
 */
export type CommonDecideRequest<A> = {
  readonly input: A
  /** Each provider narrows this to its typed literal union. */
  readonly model: string
}

export type DecisionModelService = {
  readonly decide: <A, D extends Decision.Decisions>(
    definition: Decision.Definition<A, D>,
    request: CommonDecideRequest<A>,
  ) => Effect.Effect<DecideResponse<D>, AiError.AiError>
}

/**
 * Answering typed questions about an input with probabilities instead of
 * generating text. The model reports beliefs; the decision stays in the
 * caller's code.
 *
 * Implementor contract: answer every decision or fail. Omitting one leaves a
 * hole where {@link DecideResponse} promises a key, so a kind the backing
 * cannot express is rejected up front with `Decision.assertKinds`.
 *
 * @experimental The model class this abstracts is new and the shape may change.
 */
export class DecisionModel extends Context.Service<DecisionModel, DecisionModelService>()(
  "@betalyra/effect-uai/DecisionModel",
) {}

/** Answer a definition's decisions about one input in one call. */
export const decide = <A, D extends Decision.Decisions>(
  definition: Decision.Definition<A, D>,
  request: CommonDecideRequest<A>,
): Effect.Effect<DecideResponse<D>, AiError.AiError, DecisionModel> =>
  Effect.flatMap(DecisionModel, (m) => m.decide(definition, request))
