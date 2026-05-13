/**
 * Node-specific runner for the basic-music-generation recipe.
 *
 * Modes:
 *
 * - No argument → runs both built-in variants and writes
 *   `out-simple.mp3` + `out-weighted.mp3` next to the recipe.
 * - One positional path argument →
 *   - `*.txt`  → reads the file as a single prompt, runs only the
 *               simple variant, writes `out-simple.mp3`.
 *   - `*.json` → parses the file as a `WeightedConfig`, runs only the
 *               weighted variant, writes `out-weighted.mp3`.
 *
 * Run with:
 *   `GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts`
 *   `GOOGLE_API_KEY=... pnpm tsx recipes/basic-music-generation/run-node.ts prompts/birthday-danielo.txt`
 *
 * Cost note: `lyria-3-clip-preview` is fixed at 30 s of MP3 output.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Config, Effect, Layer, Logger, Match, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as lyriaLayer } from "@effect-uai/google/LyriaGenerator"
import {
  defaultSimplePrompt,
  defaultWeightedConfig,
  runSimple,
  runWeighted,
  type WeightedConfig,
} from "./index.js"

const outDir = path.dirname(new URL(import.meta.url).pathname)

type Mode =
  | { readonly _tag: "both" }
  | { readonly _tag: "simple"; readonly prompt: string }
  | { readonly _tag: "weighted"; readonly config: WeightedConfig }

const usage = (): never => {
  console.error(
    `Usage: pnpm tsx recipes/basic-music-generation/run-node.ts [<file>]
  no args               run both built-in variants
  <file>.txt            run the simple variant with the file contents as prompt
  <file>.json           run the weighted variant with the file as WeightedConfig`,
  )
  process.exit(1)
}

const parseMode = (argPath: string | undefined): Effect.Effect<Mode> =>
  Effect.gen(function* () {
    if (argPath === undefined) {
      return { _tag: "both" } satisfies Mode
    }
    const abs = path.resolve(process.cwd(), argPath)
    const ext = path.extname(abs).toLowerCase()
    return yield* Match.value(ext).pipe(
      Match.when(".txt", () =>
        Effect.tryPromise(() => fs.readFile(abs, "utf8")).pipe(
          Effect.map((contents): Mode => ({ _tag: "simple", prompt: contents.trim() })),
          Effect.orDie,
        ),
      ),
      Match.when(".json", () =>
        Effect.tryPromise(() => fs.readFile(abs, "utf8")).pipe(
          Effect.map(
            (contents): Mode => ({
              _tag: "weighted",
              config: JSON.parse(contents) as WeightedConfig,
            }),
          ),
          Effect.orDie,
        ),
      ),
      Match.orElse((): Effect.Effect<Mode> => Effect.sync(usage)),
    )
  })

const runSimplePath =
  (prompt: string) =>
  () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("running simple variant", { promptPreview: prompt.slice(0, 80) })
      const result = yield* runSimple(prompt)
      yield* Effect.logInfo("simple generation complete", {
        bytes: result.bytes.length,
        format: result.format,
        watermark: result.watermark,
      })
      yield* Effect.tryPromise(() =>
        fs.writeFile(path.join(outDir, "out-simple.mp3"), result.bytes),
      )
      yield* Effect.logInfo("wrote out-simple.mp3 alongside this recipe")
    })

const runWeightedPath =
  (config: WeightedConfig) =>
  () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("running weighted variant", {
        promptCount: config.prompts.length,
        bpm: config.bpm,
        scale: config.scale,
        hasLyrics: config.lyrics !== undefined,
      })
      const result = yield* runWeighted(config)
      yield* Effect.logInfo("weighted generation complete", {
        bytes: result.bytes.length,
        format: result.format,
        lyrics: result.lyrics?.slice(0, 80),
        watermark: result.watermark,
      })
      yield* Effect.tryPromise(() =>
        fs.writeFile(path.join(outDir, "out-weighted.mp3"), result.bytes),
      )
      yield* Effect.logInfo("wrote out-weighted.mp3 alongside this recipe")
    })

const runMode = (mode: Mode): Effect.Effect<void, unknown, ReturnType<typeof lyriaLayer> extends Layer.Layer<infer A, any, any> ? A : never> =>
  Match.value(mode).pipe(
    Match.tag("both", () =>
      Effect.gen(function* () {
        yield* runSimplePath(defaultSimplePrompt)()
        yield* runWeightedPath(defaultWeightedConfig)()
      }),
    ),
    Match.tag("simple", ({ prompt }) => runSimplePath(prompt)()),
    Match.tag("weighted", ({ config }) => runWeightedPath(config)()),
    Match.exhaustive,
  )

const program = Effect.gen(function* () {
  const mode = yield* parseMode(process.argv[2])
  yield* runMode(mode)
})

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return lyriaLayer({ apiKey })
  }),
)

const mainLayer = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(
    Effect.provide(mainLayer),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
