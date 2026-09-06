/**
 * Composition + reporting for the dashboard-briefing recipe.
 *
 * Runtime-agnostic wiring lives here: flags (`--model`, `--url`, `--settle`,
 * `--cdp`), the briefing formatter, and the bootstrap `main`. `run.ts`
 * supplies the platform `HttpClient`.
 *
 * `--cdp` accepts either a full `ws://` endpoint or an `http://` debug
 * address (e.g. `http://127.0.0.1:9222`): Chromium mints a fresh
 * `/devtools/browser/<uuid>` WebSocket URL on every start, so the http form
 * is resolved via `/json/version` at boot instead of asking you to curl and
 * paste it.
 */
import { Console, Duration, Effect, Layer, Option, Stdio } from "effect"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { browserLayer, languageModelLayer, parseModelSpec } from "../_shared/model.js"
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
const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    model: parseModelSpec(
      Option.getOrElse(flagValue("model", argv), () => "gemini-3-flash-preview"),
      "google",
    ),
    url: Option.getOrElse(flagValue("url", argv), () => "https://plausible.io/plausible.io"),
    // Charts animate in; reading too early captures half-drawn bars.
    settle: Duration.fromInputUnsafe(
      Option.getOrElse(flagValue("settle", argv), () => "2 seconds") as Duration.Input,
    ),
    cdp: Option.getOrUndefined(flagValue("cdp", argv)),
  }
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const flags = yield* readFlags

  yield* Effect.logInfo(
    `Reading ${flags.url} (letting it settle for ${Duration.format(flags.settle)})`,
  )

  const briefing = yield* briefDashboard({ ...flags, model: flags.model.model }).pipe(
    Effect.provide(Layer.merge(browserLayer(flags.cdp), languageModelLayer(flags.model))),
  )

  yield* Console.log(`\n${formatBriefing(flags.url, briefing)}`)
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
