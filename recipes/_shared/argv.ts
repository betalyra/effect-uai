/**
 * Tiny argv helpers shared across recipe runners. Functional style: no
 * loops, no mutation. Each helper is a pure function over the argv
 * array.
 */
import { Array as Arr, Option } from "effect"

/**
 * Look up a long flag's value in `argv`. Supports both `--name=value`
 * and `--name value` forms. Returns `None` if the flag isn't present.
 *
 * Throws if `--name` is the last token (i.e. no value follows it) —
 * that's a usage error, not a missing flag.
 */
export const flagValue = (name: string, argv: ReadonlyArray<string>): Option.Option<string> => {
  const long = `--${name}`
  const eq = `${long}=`

  const inline = Arr.findFirst(argv, (a) => a.startsWith(eq)).pipe(
    Option.map((a) => a.slice(eq.length)),
  )
  if (Option.isSome(inline)) return inline

  const spaceIdx = Arr.findFirstIndex(argv, (a) => a === long)
  return Option.map(spaceIdx, (i) => {
    const next = argv[i + 1]
    if (next === undefined) throw new Error(`${long} requires a value`)
    return next
  })
}

/**
 * Parse a `--provider` flag with a recipe-specific decoder. The decoder
 * should throw on unknown values (so the user sees a useful error
 * instead of falling back silently).
 *
 * Defaults to `process.argv.slice(2)` so most callers can just pass the
 * decoder + fallback.
 */
export const providerFlag = <P extends string>(
  decode: (raw: string) => P,
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Option.Option<P> => Option.map(flagValue("provider", argv), decode)
