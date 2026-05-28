/**
 * Node runner for the basic-music-generation recipe. Dispatches
 * between Google Lyria and ElevenLabs Music via `--provider=`.
 *
 * Usage:
 *
 *   # Default: Google Lyria with the built-in prompt.
 *   GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts
 *
 *   # Explicit provider:
 *   GOOGLE_API_KEY=...     pnpm tsx recipes/basic-music-generation/run-node.ts --provider=google
 *   ELEVENLABS_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts --provider=elevenlabs
 *
 *   # Provider + custom prompt from a .txt file:
 *   ELEVENLABS_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts --provider=elevenlabs ./my-prompt.txt
 *
 * Writes `out-{provider}.mp3` next to the recipe.
 *
 * Cost note:
 * - `lyria-3-clip-preview` is fixed at 30 s of MP3.
 * - ElevenLabs `music_v1` honors `music_length_ms`; billed per
 *   generation per the active plan.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Array as Arr, Config, Effect, Layer, Logger, Match, Option, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as elevenlabsLayer } from "@effect-uai/elevenlabs/ElevenLabsMusicGenerator"
import { layer as lyriaLayer } from "@effect-uai/google/LyriaGenerator"
import { defaultModel, defaultPrompt, run, type Provider } from "./index.js"

const outDir = path.dirname(new URL(import.meta.url).pathname)

// ---------------------------------------------------------------------------
// Argv parsing (pure)
// ---------------------------------------------------------------------------

type Args = {
  readonly provider: Provider
  readonly promptPath: Option.Option<string>
}

const isProvider = (s: string): s is Provider => s === "google" || s === "elevenlabs"

const expectProvider = (v: string): Effect.Effect<Provider> =>
  isProvider(v)
    ? Effect.succeed(v)
    : Effect.die(`Unknown provider: ${v}. Use --provider=google or --provider=elevenlabs.`)

/**
 * Token = `{ provider }` from `--provider=X`, or `{ providerNext }` to
 * signal the next bare token should be parsed as the provider value
 * (handles space-separated `--provider X`), or a `{ path }` for the
 * positional prompt-file argument.
 */
type Token =
  | { readonly _tag: "provider"; readonly provider: Provider }
  | { readonly _tag: "providerNext" }
  | { readonly _tag: "path"; readonly path: string }

const tokenize = (arg: string): Effect.Effect<Token> =>
  arg === "--provider"
    ? Effect.succeed<Token>({ _tag: "providerNext" })
    : arg.startsWith("--provider=")
      ? expectProvider(arg.slice("--provider=".length)).pipe(
          Effect.map((provider): Token => ({ _tag: "provider", provider })),
        )
      : Effect.succeed<Token>({ _tag: "path", path: arg })

type ParseState = { readonly args: Args; readonly awaitingProvider: boolean }

const initialState: ParseState = {
  args: { provider: "google", promptPath: Option.none() },
  awaitingProvider: false,
}

const step = (state: ParseState, token: Token): Effect.Effect<ParseState> =>
  state.awaitingProvider && token._tag === "path"
    ? expectProvider(token.path).pipe(
        Effect.map((provider) => ({
          args: { ...state.args, provider },
          awaitingProvider: false,
        })),
      )
    : Match.value(token).pipe(
        Match.tag("provider", ({ provider }) =>
          Effect.succeed<ParseState>({
            args: { ...state.args, provider },
            awaitingProvider: false,
          }),
        ),
        Match.tag("providerNext", () =>
          Effect.succeed<ParseState>({ ...state, awaitingProvider: true }),
        ),
        Match.tag("path", ({ path }) =>
          Effect.succeed<ParseState>({
            args: { ...state.args, promptPath: Option.some(path) },
            awaitingProvider: false,
          }),
        ),
        Match.exhaustive,
      )

const parseArgs = (argv: ReadonlyArray<string>): Effect.Effect<Args> =>
  Effect.forEach(argv, tokenize).pipe(
    Effect.flatMap((tokens) =>
      Arr.reduce(tokens, Effect.succeed(initialState), (accEff, token) =>
        accEff.pipe(Effect.flatMap((acc) => step(acc, token))),
      ),
    ),
    Effect.map((state) => state.args),
  )

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

const loadPrompt = (promptPath: Option.Option<string>): Effect.Effect<string> =>
  Option.match(promptPath, {
    onNone: () => Effect.succeed(defaultPrompt),
    onSome: (p) =>
      Effect.tryPromise(() => fs.readFile(path.resolve(process.cwd(), p), "utf8")).pipe(
        Effect.map((s) => s.trim()),
        Effect.orDie,
      ),
  })

const writeOutput = (provider: Provider, bytes: Uint8Array): Effect.Effect<void> =>
  Effect.tryPromise(() => fs.writeFile(path.join(outDir, `out-${provider}.mp3`), bytes)).pipe(
    Effect.orDie,
  )

// ---------------------------------------------------------------------------
// Provider Layer dispatch
// ---------------------------------------------------------------------------

const providerLayer = Match.type<Provider>().pipe(
  Match.when("google", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
        return lyriaLayer({ apiKey })
      }),
    ),
  ),
  Match.when("elevenlabs", () =>
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.redacted("ELEVENLABS_API_KEY")
        return elevenlabsLayer({ apiKey })
      }),
    ),
  ),
  Match.exhaustive,
)

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = ({ provider, promptPath }: Args) =>
  Effect.gen(function* () {
    const prompt = yield* loadPrompt(promptPath)
    yield* Effect.logInfo(`generating with ${provider}`, {
      promptPreview: prompt.slice(0, 80),
      model: defaultModel[provider],
    })
    const result = yield* run({ model: defaultModel[provider], prompt })
    yield* Effect.logInfo("generation complete", {
      bytes: result.primary.audio.bytes.length,
      format: result.primary.audio.format,
      provider: result.primary.provider,
      watermark: result.primary.watermark,
      songId: result.primary.songId,
      variants: result.variants.length,
    })
    yield* writeOutput(provider, result.primary.audio.bytes)
    yield* Effect.logInfo(`wrote out-${provider}.mp3 alongside this recipe`)
  })

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const main = Effect.gen(function* () {
  const args = yield* parseArgs(Arr.fromIterable(process.argv.slice(2)))
  const layer = Layer.mergeAll(
    providerLayer(args.provider).pipe(Layer.provide(FetchHttpClient.layer)),
    Logger.layer([Logger.consolePretty()]),
  )
  return yield* program(args).pipe(Effect.provide(layer))
}).pipe(Effect.provideService(References.MinimumLogLevel, "Info"))

Effect.runPromise(main).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
