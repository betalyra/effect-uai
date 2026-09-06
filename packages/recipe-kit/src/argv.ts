/**
 * Tiny argv helpers shared across recipe runners. Functional style: no
 * loops, no mutation. Each helper is a pure function over the argv
 * array.
 */
import { Array as Arr, Data, Effect, Option } from "effect"

/** A `--flag` was given a value that isn't one of the accepted ones. */
export class UnknownFlag extends Data.TaggedError("UnknownFlag")<{
  readonly flag: string
  readonly value: string
  readonly expected: string
}> {}

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

/**
 * Read a `--<flag>` as one of `choices`, defaulting to the first. Absent →
 * `choices[0]`; present but not a choice → a typed `UnknownFlag` listing the
 * accepted values. The `const` type parameter makes the result the literal
 * union of `choices`, so no annotation is needed:
 *
 *   const llm = yield* choiceFlag("llm", ["openai", "gemini"])
 *   //    ^? "openai" | "gemini"
 */
export const choiceFlag = <const A extends string>(
  flag: string,
  choices: readonly [A, ...Array<A>],
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Effect.Effect<A, UnknownFlag> =>
  Option.match(flagValue(flag, argv), {
    onNone: () => Effect.succeed(choices[0]),
    onSome: (raw) =>
      Option.match(
        Arr.findFirst(choices, (c) => c.toLowerCase() === raw.toLowerCase()),
        {
          onNone: () =>
            Effect.fail(new UnknownFlag({ flag, value: raw, expected: choices.join(" | ") })),
          onSome: (c) => Effect.succeed(c),
        },
      ),
  })

/**
 * `choiceFlag` specialized to the common `--provider` flag:
 *
 *   const provider = yield* providerChoice("google", "anthropic", "openai")
 *   //    ^? "google" | "anthropic" | "openai"   (default "google")
 */
export const providerChoice = <const A extends string>(
  ...choices: readonly [A, ...Array<A>]
): Effect.Effect<A, UnknownFlag> => choiceFlag("provider", choices)

/**
 * Read a `--<flag>` as a number, keeping `fallback` when it is absent or not
 * a number. Recipe flags are dials (rounds, concurrency, how many panels),
 * where a typo should not stop the run.
 */
export const intFlag = (name: string, argv: ReadonlyArray<string>, fallback: number): number =>
  Option.match(flagValue(name, argv), {
    onNone: () => fallback,
    onSome: (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : fallback),
  })
