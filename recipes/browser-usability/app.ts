/**
 * Composition + reporting for the browser-usability recipe.
 *
 * Runtime-agnostic wiring lives here: the CDP browser Layer (generic
 * `Browser` tag) pointed at a headless Chromium, the Gemini Flash model
 * Layer (generic `LanguageModel` tag), env-driven config (`GOAL`,
 * `START_URL`, `MODEL`, `MAX_STEPS`, `CDP_URL`), the report formatter, and
 * the bootstrap `main`. The runner supplies the platform `HttpClient`.
 *
 * Swapping the browser backend is a one-line change here and nothing else:
 * point `CDP_URL` at any other CDP endpoint (a hosted vendor, a local
 * Chrome, obscura), and `recipe.ts` is untouched.
 */
import { Cause, Config, Console, Effect, Layer, Logger, References, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
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
// App-level layer: Chromium over CDP (Browser) + Gemini (LanguageModel).
// ---------------------------------------------------------------------------

const VersionInfo = Schema.Struct({ webSocketDebuggerUrl: Schema.String })

/**
 * `ws://` passes through; `http://` is resolved via CDP's `/json/version`.
 * Only the path is taken from the response - the host/port stay as
 * configured, so a port-remapped container (whose Chrome reports its
 * internal port) still resolves correctly.
 */
const resolveCdpEndpoint = (raw: string) =>
  raw.startsWith("http")
    ? Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const base = raw.replace(/\/$/, "")
        const response = yield* client.get(`${base}/json/version`)
        const body = yield* response.json
        const info = yield* Schema.decodeUnknownEffect(VersionInfo)(body)
        const path = new URL(info.webSocketDebuggerUrl).pathname
        return `${base.replace(/^http/, "ws")}${path}`
      })
    : Effect.succeed(raw)

// A headless Chromium with its DevTools port open. Start it with:
//   docker run -d --name chromium -p 127.0.0.1:9222:9222 chromedp/headless-shell
const chromiumLayer = Layer.unwrap(
  Effect.gen(function* () {
    const raw = yield* Config.string("CDP_URL").pipe(Config.withDefault("http://127.0.0.1:9222"))
    const endpoint = yield* resolveCdpEndpoint(raw)
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
  chromiumLayer,
  geminiProviderLayer,
  Logger.layer([Logger.consolePretty()]),
  logLevelLayer,
)
