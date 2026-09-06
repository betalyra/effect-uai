/**
 * Composition + reporting for the browser-usability recipe.
 *
 * Runtime-agnostic wiring lives here: flags (`--model`, `--goal`, `--url`,
 * `--max-steps`, `--cdp`), the report formatter, and the bootstrap `main`.
 * `run.ts` supplies the platform `HttpClient`.
 *
 * Swapping the browser backend is `--cdp` and nothing else: point it at any
 * other CDP endpoint (a hosted vendor, a local Chrome, obscura), and
 * `recipe.ts` is untouched.
 */
import { Cause, Console, Effect, Layer, Option, Stdio } from "effect"
import { flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { browserLayer, languageModelLayer, parseModelSpec } from "../_shared/model.js"
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
const DEFAULT_GOAL =
  "Shop for calligraphy brush pens: find them (search, or browse the category tree if search does not respond), add two different brush pens to the cart, then open the ORDER page and report how many items are in the cart and the total price. Stop at the checkout page; do not sign in or pay."

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    model: parseModelSpec(
      Option.getOrElse(flagValue("model", argv), () => "gemini-3-flash-preview"),
      "google",
    ),
    goal: Option.getOrElse(flagValue("goal", argv), () => DEFAULT_GOAL),
    startUrl: Option.getOrElse(flagValue("url", argv), () => "https://next-faster.vercel.app"),
    maxSteps: intFlag("max-steps", argv, 20),
    cdp: Option.getOrUndefined(flagValue("cdp", argv)),
  }
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const flags = yield* readFlags

  yield* Effect.logInfo(
    `Driving ${flags.startUrl} toward: "${flags.goal}" (max ${flags.maxSteps} steps)`,
  )

  const report = yield* runUsabilityTest({ ...flags, model: flags.model.model }).pipe(
    Effect.provide(Layer.merge(browserLayer(flags.cdp), languageModelLayer(flags.model))),
  )

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
