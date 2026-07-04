/**
 * Composition + reporting for the browser-usability recipe.
 *
 * Runtime-agnostic wiring lives here: the obscura CDP browser Layer (generic
 * `Browser` tag), the Gemini Flash model Layer (generic `LanguageModel`
 * tag), env-driven config (`GOAL`, `START_URL`, `MODEL`, `MAX_STEPS`,
 * `OBSCURA_CDP_URL`), the report formatter, and the bootstrap `main`. The
 * runner supplies the platform `HttpClient`.
 *
 * Swapping the browser backend is a one-line change here and nothing else:
 * replace `obscuraLayer` with any other `Browser` provider (a hosted CDP
 * vendor, a local Chromium), and `recipe.ts` is untouched.
 */
import { Cause, Config, Console, Effect, Layer, Logger, References } from "effect"
import { layer as cdpLayer } from "@effect-uai/browser/Connect"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { runUsabilityTest, type UsabilityReport } from "./recipe.js"

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const formatReport = (report: UsabilityReport): string => {
  const verdict = report.goalAchieved ? "✓ GOAL REACHED" : "✗ GOAL NOT REACHED"
  const trail = report.trail.map((s) => {
    const why = s.reasoning === "" ? "" : `\n     ${s.reasoning}`
    return `  ${s.n}. ${s.action}${why}\n     -> ${s.outcome}`
  })
  const friction =
    report.friction.length === 0
      ? "  (none reported)"
      : report.friction.map((f) => `  - ${f}`).join("\n")
  return [
    `${verdict}  (${report.stepsUsed} steps)`,
    `Goal: ${report.goal}`,
    "",
    "Summary:",
    `  ${report.summary}`,
    "",
    "Trail:",
    ...trail,
    "",
    "Friction:",
    friction,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Default scenario: a full e-commerce shopping flow against NextFaster, an
// open-source art-supplies demo store. It exercises the verbs a read-only
// goal never touches (category navigation, adding to cart, search submit) and
// stops cleanly at the checkout boundary.
const recipeConfig = Config.all({
  model: Config.string("MODEL").pipe(Config.withDefault("gemini-3-flash-preview")),
  goal: Config.string("GOAL").pipe(
    Config.withDefault(
      "Shop for calligraphy brush pens: find them (search, or browse the category tree if search does not respond), add two different brush pens to the cart, then open the ORDER page and report how many items are in the cart and the total price. Stop at the checkout page; do not sign in or pay.",
    ),
  ),
  startUrl: Config.string("START_URL").pipe(Config.withDefault("https://next-faster.vercel.app")),
  maxSteps: Config.int("MAX_STEPS").pipe(Config.withDefault(20)),
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const cfg = yield* recipeConfig

  yield* Effect.logInfo(`Driving ${cfg.startUrl} toward: "${cfg.goal}" (max ${cfg.maxSteps} steps)`)

  const report = yield* runUsabilityTest(cfg)

  yield* Console.log(`\n${formatReport(report)}`)
}).pipe(
  Effect.tapCause((cause) =>
    Effect.gen(function* () {
      yield* Effect.logError("[main] failed", { cause })
      const err = Cause.squash(cause) as { readonly raw?: unknown }
      if (err?.raw !== undefined) yield* Console.error("RAW ERROR BODY:", err.raw)
    }),
  ),
)

// ---------------------------------------------------------------------------
// App-level layer: obscura (Browser) + Gemini (LanguageModel) + logging.
// ---------------------------------------------------------------------------

// obscura's browser-level CDP endpoint. Start it with:
//   docker run -d --name obscura -p 127.0.0.1:9222:9222 h4ckf0r0day/obscura
const obscuraLayer = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* Config.string("OBSCURA_CDP_URL").pipe(
      Config.withDefault("ws://127.0.0.1:9222/devtools/browser"),
    )
    return cdpLayer({ endpoint })
  }),
)

const geminiProviderLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_API_KEY")
    return geminiLayer({ apiKey })
  }),
)

const logLevelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const level = yield* Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const))
    return Layer.succeed(References.MinimumLogLevel, level)
  }),
)

export const appLayer = Layer.mergeAll(
  obscuraLayer,
  geminiProviderLayer,
  Logger.layer([Logger.consolePretty()]),
  logLevelLayer,
)
