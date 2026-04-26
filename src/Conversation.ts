import { Option } from "effect"
import type { Item } from "./Items.js"
import type { Turn } from "./Turn.js"

/**
 * Build the cursor for the just-completed turn. State must carry at least a
 * `history: ReadonlyArray<Item>` field; every other field is preserved on the
 * returned cursor (e.g. `index`, `model`, anything you thread through the
 * loop). The cursor's `history` is `state.history` extended with the turn's
 * items.
 */
export const cursor = <S extends { readonly history: ReadonlyArray<Item> }>(
  state: S,
  turn: Turn,
): S & { readonly turn: Turn } => ({
  ...state,
  history: [...state.history, ...turn.items],
  turn,
})

/**
 * Terminate the `Stream.paginate` loop, emitting `value` as the final element.
 * The state type unifies with `advance`'s `Option.some(next)` in the union of
 * branch returns, so no explicit type argument is required.
 */
export const stop = <A>(value: A) => [[value], Option.none()] as const

/**
 * Continue the `Stream.paginate` loop with `nextState`, emitting `value` as
 * the cursor for the just-completed turn. The state shape is inferred from
 * `nextState`.
 */
export const advance = <A, S>(value: A, nextState: S) =>
  [[value], Option.some(nextState)] as const
