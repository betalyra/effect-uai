/**
 * Where a recipe writes what it produced.
 *
 * One root for every recipe (`output/<recipe>/<timestamp>/`), so runs never
 * land in the source tree, two recipes never collide, and `.gitignore`
 * needs one line rather than one per recipe.
 */
import { DateTime, Effect, Option } from "effect"
import { flagValue } from "./argv.js"

/** `2026-09-05T11-04-22`: sortable, filename-safe, and unique per run. */
const stamp = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(now).slice(0, 19).replaceAll(":", "-"),
)

/**
 * A fresh directory for this run, or whatever `--out` names. A run never
 * clears the directory it writes to, so an `--out` you have used before
 * leaves you reading a board that is part old and part new; the timestamped
 * default cannot collide.
 */
export const runDir = (recipe: string, argv: ReadonlyArray<string>): Effect.Effect<string> =>
  Option.match(flagValue("out", argv), {
    onNone: () => Effect.map(stamp, (at) => `output/${recipe}/${at}`),
    onSome: Effect.succeed,
  })
