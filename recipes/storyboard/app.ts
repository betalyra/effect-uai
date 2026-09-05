/**
 * Composition + rendering for the storyboard recipe.
 *
 * Two providers, two keys: `OPENAI_API_KEY` for the images and
 * `LLM_API_KEY` for the director and the critic. Both Layers register the
 * generic tags, so `recipe.ts` never names either vendor; point
 * `--base-url` / `--llm-base-url` at a gateway and the same code runs there.
 *
 * The comic itself is data: `story.json`, decoded here, `--story` to point
 * at another one. Each run writes to its own timestamped directory, so a
 * run never overwrites an earlier one (or the committed `example/` board).
 *
 * The runners supply the platform `HttpClient`, `FileSystem` and `Path`.
 */
import {
  Cause,
  Config,
  DateTime,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Logger,
  Match,
  Option,
  Path,
  References,
  Result,
  Schema,
  Stdio,
  Stream,
} from "effect"
import type { ImageResolution, ImageSource } from "@effect-uai/core/Image"
import { layer as openaiImageLayer } from "@effect-uai/openai/OpenAIImageGenerator"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { flagValue } from "../_shared/argv.js"
import { cyan, dim } from "../_shared/render.js"
import { board, BoardEvent, type BoardConfig, isPanelReady, type Panel } from "./recipe.js"

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

/**
 * Data, not code, so a new comic is a new file and nothing to compile.
 * Decoded rather than cast: a hand-written story with a typo should say
 * which field, not fail eight image calls later.
 */
const Story = Schema.Struct({
  /** Restated verbatim on every prompt. It holds the medium. */
  style: Schema.String,
  /** Generated first, then attached to the panels that name them. */
  sheets: Schema.Array(Schema.Struct({ id: Schema.String, description: Schema.String })),
  beats: Schema.Array(Schema.Struct({ page: Schema.Number, shot: Schema.String })),
})
type Story = typeof Story.Type

const readStory = (file: string): Effect.Effect<Story, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file)
    const json = yield* Effect.try(() => JSON.parse(text) as unknown)
    return yield* Schema.decodeUnknownEffect(Story)(json)
  }).pipe(Effect.orDie)

type Flags = {
  readonly imageModel: string
  readonly llmModel: string
  readonly resolution: ImageResolution
  readonly outDir: string
  readonly story: string
  readonly rounds: number
  readonly concurrency: number
  readonly panels: number
}

const isResolution = (s: string): s is ImageResolution => s === "1K" || s === "2K" || s === "4K"

const intFlag = (name: string, argv: ReadonlyArray<string>, fallback: number): number =>
  Option.match(flagValue(name, argv), {
    onNone: () => fallback,
    onSome: (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : fallback),
  })

/** `2026-09-05T11-04-22`: sortable, filename-safe, and unique per run. */
const stamp = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(now).slice(0, 19).replaceAll(":", "-"),
)

const readFlags: Effect.Effect<Flags, never, Stdio.Stdio | Path.Path> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const path = yield* Path.Path
  const argv = yield* stdio.args
  const resolution = Option.getOrElse(flagValue("resolution", argv), () => "1K")
  const out = yield* Option.match(flagValue("out", argv), {
    onNone: () => Effect.map(stamp, (at) => `storyboard-out/${at}`),
    onSome: Effect.succeed,
  })
  const here = path.dirname(new URL(import.meta.url).pathname)
  return {
    imageModel: Option.getOrElse(flagValue("model", argv), () => "gpt-image-2"),
    llmModel: Option.getOrElse(flagValue("llm-model", argv), () => "gpt-5.2"),
    resolution: isResolution(resolution) ? resolution : "1K",
    outDir: out,
    /** Beside the recipe unless pointed elsewhere, so it runs from any cwd. */
    story: Option.getOrElse(flagValue("story", argv), () =>
      path.join(here, "stories", "kite.json"),
    ),
    rounds: intFlag("rounds", argv, 1),
    // Bounds the cast and stage stages only; panels are always sequential.
    // Image endpoints rate-limit by images per minute, so drop this if the
    // provider starts returning 429s.
    concurrency: intFlag("concurrency", argv, 8),
    /** Cut the board short. `--panels 1` is a one-call smoke test. */
    panels: intFlag("panels", argv, Number.POSITIVE_INFINITY),
  }
})

const write = (s: string) => Effect.sync(() => process.stdout.write(s))

// ---------------------------------------------------------------------------
// Writing panels to disk
// ---------------------------------------------------------------------------

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

/**
 * Providers may hand back bytes, base64, or a URL. The first two are on
 * disk immediately; a URL would need a fetch, which this recipe leaves to
 * the caller rather than pretending every source is local.
 */
const bytesOf: (source: ImageSource) => Effect.Effect<Uint8Array> = Match.type<ImageSource>().pipe(
  Match.tag("bytes", (s) => Effect.succeed(s.bytes)),
  Match.tag("base64", (s) =>
    Result.match(Encoding.decodeBase64(s.base64), {
      onSuccess: Effect.succeed,
      onFailure: (cause) => Effect.die(cause),
    }),
  ),
  Match.tag("url", (s) => Effect.die(`Expected inline image data, got a URL: ${s.url}`)),
  Match.exhaustive,
)

const extensionOf = (source: ImageSource): string =>
  source._tag === "url" ? "png" : (EXTENSION[source.mimeType] ?? "png")

const writeImage = (
  outDir: string,
  name: string,
  image: ImageSource,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = `${name}.${extensionOf(image)}`
    yield* fs.makeDirectory(outDir, { recursive: true }).pipe(Effect.orDie)
    yield* Effect.flatMap(bytesOf(image), (bytes) => fs.writeFile(`${outDir}/${file}`, bytes)).pipe(
      Effect.orDie,
    )
    return file
  })

/** The director's plan, kept beside the images: a run you cannot read is a run you cannot debug. */
const writeJson = (
  outDir: string,
  name: string,
  value: unknown,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(outDir, { recursive: true })
    yield* fs.writeFileString(`${outDir}/${name}`, `${JSON.stringify(value, null, 2)}\n`)
  }).pipe(Effect.orDie)

const clip = (s: string, max = 64) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

const secs = (millis: number) => `${(millis / 1000).toFixed(1)}s`

const panelName = (panel: Panel): string =>
  `page-${panel.page}-panel-${String(panel.index + 1).padStart(2, "0")}`

/**
 * Every image the run produced lands on disk as it arrives, including the
 * sheets and the attempts the critic threw out: seeing what drifted is how
 * you tune the sheets and the style block.
 */
const report =
  (outDir: string) =>
  (event: BoardEvent): Effect.Effect<void, never, FileSystem.FileSystem> =>
    BoardEvent.$match(event, {
      SheetReady: ({ id, image }) =>
        Effect.flatMap(writeImage(`${outDir}/sheets`, id, image), (file) =>
          write(`  ${cyan("sheet")}     sheets/${file}\n`),
        ),
      // The director's output is the one piece of model text worth reading:
      // it says what each panel will be and what it will carry. Written out
      // in full as well, since the terminal only has room for the gist.
      Directed: ({ scenes, shots }) =>
        Effect.andThen(
          writeJson(outDir, "shots.json", { scenes, shots }),
          write(
            `\n${cyan("directed")}  ${scenes.length} scenes\n${shots
              .map(
                (s) =>
                  `  ${String(s.panel).padStart(2)}. ${clip(s.prompt)}\n      ${dim(`${s.aspect}  ${s.scene}  [${s.sheets.join(", ")}]`)}`,
              )
              .join("\n")}\n\n`,
          ),
        ),
      SceneReady: ({ id, image, millis }) =>
        Effect.flatMap(writeImage(`${outDir}/scenes`, id, image), (file) =>
          write(`  ${cyan("scene")}     scenes/${file}  ${dim(`in ${secs(millis)}`)}\n`),
        ),
      PanelStarted: ({ attempt, spec }) =>
        write(
          `  ${dim("drawing")}   panel ${spec.panel}${attempt > 1 ? ` (take ${attempt})` : ""}\n`,
        ),
      PanelRendered: ({ attempt, millis, panel }) =>
        write(
          `  ${dim("judging")}   panel ${panel.index + 1} take ${attempt}  ${dim(`drew in ${secs(millis)}`)}\n`,
        ),
      PanelRejected: ({ attempt, millis, note, panel }) =>
        Effect.flatMap(
          writeImage(`${outDir}/rejected`, `${panelName(panel)}-take-${attempt}`, panel.image),
          (file) =>
            write(
              `  ${dim("redo")}      rejected/${file}  ${dim(`judged in ${secs(millis)}`)}\n            ${dim(note)}\n`,
            ),
        ),
      PanelReady: ({ millis, panel }) =>
        Effect.flatMap(writeImage(outDir, panelName(panel), panel.image), (file) =>
          write(
            `  ${cyan("panel")}     ${file}  ${dim(`judged in ${secs(millis)}`)}${
              panel.rejected === undefined
                ? ""
                : `\n            ${dim(`unresolved: ${panel.rejected}`)}`
            }\n`,
          ),
        ),
    })

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const flags = yield* readFlags
  const story = yield* readStory(flags.story)
  const beats = story.beats.slice(0, flags.panels)
  const cfg: BoardConfig = {
    style: story.style,
    sheets: story.sheets,
    beats,
    imageModel: flags.imageModel,
    llmModel: flags.llmModel,
    resolution: flags.resolution,
    rounds: flags.rounds,
    concurrency: flags.concurrency,
  }

  yield* write(
    `\n${cyan("comic")}  ${beats.length} panels over ${
      new Set(beats.map((b) => b.page)).size
    } pages, ${story.sheets.length} reference sheets\n${dim(
      `${flags.imageModel} at ${flags.resolution}, directed by ${flags.llmModel}`,
    )}\n`,
  )

  // Every image lands the moment it arrives, so the first panels are on
  // disk and on screen while the rest are still rendering.
  const panels = yield* board(cfg).pipe(
    Stream.tap(report(flags.outDir)),
    Stream.filter(isPanelReady),
    Stream.runCollect,
  )

  yield* write(`\n${dim(`wrote ${panels.length} panels to ${flags.outDir}/`)}\n\n`)
}).pipe(
  // Image endpoints refuse for reasons worth reading (moderation, quota, an
  // out-of-range size), and the reason is on the error's `raw`, not its message.
  Effect.tapCause((cause) =>
    Effect.logError("[main] failed", {
      error: Option.getOrUndefined(Cause.findErrorOption(cause)),
    }),
  ),
)

const gatewayUrl = (flag: string) =>
  Option.match(flagValue(flag, process.argv.slice(2)), {
    onNone: () => ({}),
    onSome: (url) => ({ baseUrl: url }),
  })

export const appLayer = Layer.mergeAll(
  Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("OPENAI_API_KEY")
      return openaiImageLayer({ apiKey, ...gatewayUrl("base-url") })
    }),
  ),
  Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("LLM_API_KEY")
      return responsesLayer({ apiKey, ...gatewayUrl("llm-base-url") })
    }),
  ),
  Logger.layer([Logger.consolePretty()]),
  Layer.unwrap(
    Effect.gen(function* () {
      const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
      return Layer.succeed(References.MinimumLogLevel, level)
    }),
  ),
)
