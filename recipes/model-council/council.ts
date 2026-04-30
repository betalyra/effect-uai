import { Stream } from "effect"
import * as AiError from "@betalyra/effect-uai-core/AiError"
import type * as Items from "@betalyra/effect-uai-core/Items"
import type { LanguageModelService } from "@betalyra/effect-uai-core/LanguageModel"
import type * as Turn from "@betalyra/effect-uai-core/Turn"

export interface Member {
  readonly name: string
  readonly service: LanguageModelService
}

export type CouncilEvent =
  | { readonly type: "delta"; readonly member: string; readonly delta: Turn.TurnDelta }
  | { readonly type: "error"; readonly member: string; readonly error: AiError.AiError }

const memberStream = (
  member: Member,
  history: ReadonlyArray<Items.Item>,
): Stream.Stream<CouncilEvent> =>
  member.service.streamTurn(history, {}).pipe(
    Stream.map(
      (delta): CouncilEvent => ({ type: "delta", member: member.name, delta }),
    ),
    Stream.catch((error) =>
      Stream.succeed<CouncilEvent>({ type: "error", member: member.name, error }),
    ),
  )

/**
 * Fan a single history out to N members concurrently. Each member's deltas
 * are tagged with the member's name and merged into a single stream.
 * Failures from one member surface as `error` events and do not affect the
 * other members.
 */
export const council = (
  members: ReadonlyArray<Member>,
  history: ReadonlyArray<Items.Item>,
): Stream.Stream<CouncilEvent> =>
  Stream.mergeAll(
    members.map((m) => memberStream(m, history)),
    { concurrency: members.length },
  )
