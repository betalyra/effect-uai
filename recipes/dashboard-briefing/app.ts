/**
 * Composition + reporting for the dashboard-briefing recipe.
 *
 * Runtime-agnostic wiring lives here: the CDP browser Layer (generic
 * `Browser` tag) pointed at a real Chromium, the Gemini vision-model Layer
 * (generic `LanguageModel` tag), env-driven config (`DASHBOARD_URL`,
 * `MODEL`, `CDP_URL`, `SETTLE`), the briefing formatter, and the bootstrap
 * `main`. The runner supplies the platform `HttpClient`.
 *
 * `CDP_URL` accepts either a full `ws://` endpoint or an `http://` debug
 * address (e.g. `http://127.0.0.1:9222`): Chromium mints a fresh
 * `/devtools/browser/<uuid>` WebSocket URL on every start, so the http form
 * is resolved via `/json/version` at boot instead of asking you to curl and
 * paste it.
 */
import { Config, Console, Duration, Effect, Layer, Logger, References, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { layer as cdpLayer } from "@effect-uai/browser/Connect"
import { layer as geminiLayer } from "@effect-uai/google/Gemini"
import { type Briefing, briefDashboard } from "./recipe.js"

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const TREND = { up: "↑ trending up", down: "↓ trending down", flat: "→ flat" } as const

const formatBriefing = (url: string, briefing: Briefing): string => {
  const headline =
    briefing.headline.length === 0
      ? []
      : [briefing.headline.map((m) => `  ${m.metric}: ${m.value}`).join("\n"), ""]
  const anomalies =
    briefing.anomalies.length === 0
      ? "  (nothing unusual)"
      : briefing.anomalies.map((a) => `  - ${a.when}: ${a.what}`).join("\n")
  return [
    `DASHBOARD BRIEFING - ${url}`,
    `Period: ${briefing.period}  ${TREND[briefing.trend]}`,
    "",
    ...headline,
    "Worth a look:",
    anomalies,
    "",
    briefing.summary,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Default target: Plausible's own public live dashboard - real traffic data,
// shared by design. Point DASHBOARD_URL at any dashboard you can open in a
// browser (a Plausible share link, a public Grafana, a vendor usage page).
const recipeConfig = Config.all({
  model: Config.string("MODEL").pipe(Config.withDefault("gemini-3-flash-preview")),
  url: Config.string("DASHBOARD_URL").pipe(Config.withDefault("https://plausible.io/plausible.io")),
  settle: Config.string("SETTLE").pipe(
    Config.withDefault("2 seconds"),
    Config.map((s) => Duration.fromInputUnsafe(s as Duration.Input)),
  ),
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const cfg = yield* recipeConfig

  yield* Effect.logInfo(`Reading ${cfg.url} (letting it settle for ${Duration.format(cfg.settle)})`)

  const briefing = yield* briefDashboard(cfg)

  yield* Console.log(`\n${formatBriefing(cfg.url, briefing)}`)
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))

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

// A dashboard read wants a real renderer: start a local Chrome/Chromium with
// its DevTools port open (see run-node.ts for the exact command).
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
