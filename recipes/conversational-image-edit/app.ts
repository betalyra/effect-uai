/**
 * Composition + rendering for the conversational-image-edit recipe.
 *
 * The terminal is the loop: `Terminal.readLine` becomes a `Stream` of
 * requests, `session` turns each into an image, and every frame is drawn
 * inline where the terminal supports it. Ctrl-C ends the session.
 *
 * `--model` takes a `provider:model` spec, resolved by `_shared/model.ts`.
 * The runners supply the platform services; nothing here is Node-specific.
 */
import {
  Cause,
  Config,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Logger,
  Match,
  Option,
  References,
  Result,
  Stdio,
  Stream,
  Terminal,
} from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { ImageResolution, ImageSource } from "@effect-uai/core/Image"
import {
  edit,
  generate,
  type ImageGenerator,
  ImageStreamEvent,
  type ImageStreaming,
  streamEdit,
  streamGeneration,
} from "@effect-uai/core/ImageGenerator"
import { flagValue } from "../_shared/argv.js"
import { inlineImage } from "../_shared/inline-image.js"
import {
  imageGeneratorLayer,
  type ModelSpec,
  parseModelSpec,
  streamingImageGeneratorLayer,
  streamsPartialImages,
} from "../_shared/model.js"
import { runDir } from "../_shared/output.js"
import { cyan, dim } from "../_shared/render.js"
import { type Draw, SessionEvent, session } from "./recipe.js"

type Flags = {
  readonly image: ModelSpec
  readonly resolution: ImageResolution
  /** 0 asks for no previews at all, whatever the provider can do. */
  readonly previews: 0 | 1 | 2 | 3
  readonly outDir: string
}

const isResolution = (s: string): s is ImageResolution => s === "1K" || s === "2K" || s === "4K"

const isPreviewCount = (n: number): n is 0 | 1 | 2 | 3 => n >= 0 && n <= 3 && Number.isInteger(n)

const readFlags: Effect.Effect<Flags, never, Stdio.Stdio> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const resolution = Option.getOrElse(flagValue("resolution", argv), () => "1K")
  const previews = Number(Option.getOrElse(flagValue("previews", argv), () => "2"))
  return {
    image: parseModelSpec(
      Option.getOrElse(flagValue("model", argv), () => "gpt-image-2"),
      "openai",
    ),
    resolution: isResolution(resolution) ? resolution : "1K",
    previews: isPreviewCount(previews) ? previews : 2,
    outDir: yield* runDir("conversational-image-edit", argv),
  }
})

// ---------------------------------------------------------------------------
// Writing images to disk
// ---------------------------------------------------------------------------

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

/** A URL source would need a fetch, which this recipe leaves to the caller. */
const bytesOf: (source: ImageSource) => Effect.Effect<Uint8Array> = Match.type<ImageSource>().pipe(
  Match.tag("bytes", (s) => Effect.succeed(s.bytes)),
  Match.tag("base64", (s) =>
    Result.match(Encoding.decodeBase64(s.base64), {
      onSuccess: Effect.succeed,
      onFailure: Effect.die,
    }),
  ),
  Match.tag("url", (s) => Effect.die(`Expected inline image data, got a URL: ${s.url}`)),
  Match.exhaustive,
)

const base64Of: (source: ImageSource) => Effect.Effect<string> = Match.type<ImageSource>().pipe(
  Match.tag("base64", (s) => Effect.succeed(s.base64)),
  Match.orElse((s) => Effect.map(bytesOf(s), Encoding.encodeBase64)),
)

const writeImage = (
  outDir: string,
  name: string,
  image: ImageSource,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = `${outDir}/${name}.${image._tag === "url" ? "png" : (EXTENSION[image.mimeType] ?? "png")}`
    yield* fs.makeDirectory(outDir, { recursive: true })
    yield* Effect.flatMap(bytesOf(image), (bytes) => fs.writeFile(file, bytes))
    return file
  }).pipe(Effect.orDie)

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const secs = (millis: number) => `${(millis / 1000).toFixed(1)}s`

const prompt = `${cyan("you")}  `

const turnName = (turn: number) => `turn-${String(turn).padStart(2, "0")}`

/**
 * Show an image where the terminal can draw one, and always keep the file:
 * previews are worth watching, but only the finished frames are worth
 * keeping, so previews are drawn and dropped.
 */
const show =
  (paint: Option.Option<(base64: string) => string>) =>
  (image: ImageSource): Effect.Effect<void, never, Terminal.Terminal> =>
    Option.match(paint, {
      onNone: () => Effect.void,
      onSome: (encode) =>
        Effect.flatMap(base64Of(image), (base64) =>
          Effect.flatMap(Terminal.Terminal, (t) => t.display(encode(base64))).pipe(Effect.orDie),
        ),
    })

const render = (
  flags: Flags,
  paint: Option.Option<(base64: string) => string>,
  event: SessionEvent,
): Effect.Effect<void, never, FileSystem.FileSystem | Terminal.Terminal> =>
  Effect.flatMap(Terminal.Terminal, (terminal) => {
    const say = (text: string) => terminal.display(text).pipe(Effect.orDie)
    return SessionEvent.$match(event, {
      Started: ({ request }) => say(`  ${dim("drawing")}  ${dim(request)}\n`),
      // Written as well as drawn: a terminal that cannot draw silently
      // ignores the escape sequence, and then a file is the only evidence
      // that anything is happening at all.
      Preview: (e) =>
        Effect.gen(function* () {
          yield* show(paint)(e.image)
          const file = yield* writeImage(
            `${flags.outDir}/previews`,
            `${turnName(e.turn)}-preview-${e.index + 1}`,
            e.image,
          )
          yield* say(`  ${dim("preview")}   ${dim(file)}\n`)
        }),
      Ready: (e) =>
        Effect.gen(function* () {
          yield* show(paint)(e.image)
          const file = yield* writeImage(
            flags.outDir,
            `turn-${String(e.turn).padStart(2, "0")}`,
            e.image,
          )
          yield* say(`  ${cyan("ready")}    ${file}  ${dim(`in ${secs(e.millis)}`)}\n\n`)
        }),
    })
  })

// ---------------------------------------------------------------------------
// The two ways to draw
//
// Streaming is the better experience and not every provider has it, so the
// choice is made once here, next to the Layer that decides the same thing.
// ---------------------------------------------------------------------------

type Drawing = { readonly model: string; readonly resolution: ImageResolution }

const previewing =
  (cfg: Drawing, partialImages: 1 | 2 | 3): Draw<ImageGenerator | ImageStreaming> =>
  (prompt, references) =>
    references.length === 0
      ? streamGeneration({ ...cfg, prompt, partialImages })
      : streamEdit({ ...cfg, prompt, partialImages, images: references })

/** One `Complete` and nothing before it, which the session reads the same way. */
const whole =
  (cfg: Drawing): Draw<ImageGenerator> =>
  (prompt, references) =>
    Stream.fromEffect(
      Effect.map(
        references.length === 0
          ? generate({ ...cfg, prompt })
          : edit({ ...cfg, prompt, images: references }),
        (response) => ImageStreamEvent.Complete(response),
      ),
    )

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

/**
 * A request per line, read straight off stdin rather than through
 * `Terminal.readLine`: that one puts the tty in raw mode without giving
 * readline an `output`, so nothing you type or paste is echoed back. Plain
 * stdin leaves the terminal cooked, which is what gives you your own
 * characters, backspace and paste, all from the driver and for free.
 */
const requests: Stream.Stream<string, never, Stdio.Stdio | Terminal.Terminal> = Stream.unwrap(
  Effect.map(Stdio.Stdio, (stdio) =>
    stdio.stdin.pipe(
      Stream.orDie,
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
    ),
  ),
)

export const main = Effect.gen(function* () {
  const flags = yield* readFlags
  const terminal = yield* Terminal.Terminal
  const columns = yield* terminal.columns
  const paint = yield* inlineImage(Math.min(60, Math.max(20, Math.floor(columns / 2))))
  const cfg: Drawing = { model: flags.image.model, resolution: flags.resolution }
  // Previews need both halves: a provider that emits them and a caller
  // who wants them. `--previews 0` is the way past a gateway that accepts
  // the request and then does not stream.
  const previews = flags.previews !== 0 && streamsPartialImages(flags.image.provider)
  const base = gatewayUrl("base-url")

  // Both branches end in the same `Effect<number>`; only the renderer and
  // the Layer differ, and they have to agree, which is why they are chosen
  // together rather than in two places.
  const run = <R, E>(draw: Draw<R>, layer: Layer.Layer<R, E, HttpClient.HttpClient>) =>
    session(requests, draw).pipe(
      Stream.tap((event) => render(flags, paint, event)),
      Stream.runCount,
      Effect.provide(layer),
    )

  yield* terminal
    .display(
      `\n${cyan("edit")}  ${flags.image.provider} ${flags.image.model} at ${flags.resolution}${
        previews ? `, ${flags.previews} previews a turn` : ""
      }\n${dim(
        [
          "Describe a picture, then keep changing it. Ctrl-C to stop.",
          ...(previews
            ? []
            : ["This provider draws the whole image at once, so there are no previews."]),
          ...(Option.isSome(paint)
            ? []
            : ["This terminal cannot draw images, so open the files as they land."]),
        ].join(" "),
      )}\n\n${prompt}`,
    )
    .pipe(Effect.orDie)

  const turns = yield* flags.previews !== 0 && streamsPartialImages(flags.image.provider)
    ? run(previewing(cfg, flags.previews), streamingImageGeneratorLayer(flags.image, base))
    : run(whole(cfg), imageGeneratorLayer(flags.image, base))

  yield* terminal
    .display(`${dim(`${turns} turns, written to ${flags.outDir}/`)}\n\n`)
    .pipe(Effect.orDie)
}).pipe(
  // Image endpoints refuse for reasons worth reading (moderation, quota),
  // and the reason is on the error's `raw`, not its message.
  Effect.tapCause((cause) =>
    Effect.logError("[main] failed", {
      error: Option.getOrUndefined(Cause.findErrorOption(cause)),
    }),
  ),
)

/** Escape hatch for a gateway the registry has no name for. */
const gatewayUrl = (flag: string): string | undefined =>
  Option.getOrUndefined(flagValue(flag, process.argv.slice(2)))

export const appLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  Layer.unwrap(
    Effect.gen(function* () {
      const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
      return Layer.succeed(References.MinimumLogLevel, level)
    }),
  ),
)
