/**
 * Draw an image in the terminal, where the terminal can draw one.
 *
 * Both protocols take base64 PNG bytes, which every image adapter already
 * hands back, so neither costs a dependency. Terminals that speak neither
 * get `None` and the caller falls back to writing a file.
 */
import { Config, Effect, Option } from "effect"

/**
 * iTerm2's inline-image escape, also read by WezTerm and by VS Code once
 * `terminal.integrated.enableImages` is on. A terminal that does not know
 * it drops the sequence in silence, so callers need a visible fallback.
 */
const iterm = (columns: number) => (base64: string) =>
  `\x1b]1337;File=inline=1;width=${columns};preserveAspectRatio=1:${base64}\x07\n`

/** The kitty graphics protocol; `f=100` says the payload is a PNG. */
const kitty = () => (base64: string) => `\x1b_Gf=100,a=T;${base64}\x1b\\\n`

const env = (name: string): Effect.Effect<string> =>
  Config.string(name).pipe(Effect.orElseSucceed(() => ""))

/**
 * How this terminal draws an image, if it does. `columns` is how wide to
 * draw, in character cells.
 */
export const inlineImage = (
  columns: number,
): Effect.Effect<Option.Option<(base64: string) => string>> =>
  Effect.map(Effect.all([env("TERM_PROGRAM"), env("TERM")]), ([program, term]) =>
    term.includes("kitty") || program === "ghostty"
      ? Option.some(kitty())
      : program === "iTerm.app" || program === "WezTerm" || program === "vscode"
        ? Option.some(iterm(columns))
        : Option.none(),
  )
