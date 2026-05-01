import { Match } from "effect"

/**
 * Dispatch on the `type` discriminator of a tagged union. Equivalent to
 * `Match.discriminator("type")`, exposed as a named helper because the
 * `type` field is the framework's convention for `Item`, `TurnEvent`,
 * `ContentBlock`, and most provider wire types.
 */
export const matchType = Match.discriminator("type")
