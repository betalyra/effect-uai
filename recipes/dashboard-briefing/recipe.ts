/**
 * Dashboard briefing. Point the agent at a dashboard you would check by
 * hand (analytics, ops, a vendor's usage page) and get back a typed
 * briefing: the trend, the anomalies worth investigating, the headline
 * numbers. Most dashboards render their charts client-side, so the
 * dashboard IS the only API you have: a reader or scraper gets an empty
 * app shell, while a browser + vision model reads it exactly like you do.
 *
 * The composition is the judge/verdict pattern, not an agent loop: open the
 * page in a real browser, screenshot it, and decode one vision
 * `LanguageModel` turn against a `Schema`. Everything the model claims is
 * grounded in the pixels it was shown.
 */
import { type Duration, Effect, Schema } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import * as CoreBrowser from "@effect-uai/core/Browser"
import type * as BrowserError from "@effect-uai/core/BrowserError"
import * as Image from "@effect-uai/core/Image"
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// The briefing schema. Annotations reach the model through the structured-
// output JSON schema, so each field doubles as an instruction.
// ---------------------------------------------------------------------------

const HeadlineMetric = Schema.Struct({
  metric: Schema.String.annotate({
    description: "Name of a stat tile as labeled on the dashboard, e.g. 'Unique visitors'.",
  }),
  value: Schema.String.annotate({
    description: "Its displayed value, verbatim, including units and change markers.",
  }),
})

const Anomaly = Schema.Struct({
  when: Schema.String.annotate({
    description: "Where on the timeline, using the chart's own axis labels.",
  }),
  what: Schema.String.annotate({
    description:
      "What stands out and roughly how large, e.g. 'spike to ~2x the surrounding baseline'.",
  }),
})

export const Briefing = Schema.Struct({
  period: Schema.String.annotate({
    description: "The time range the dashboard shows, as displayed (e.g. 'Last 30 days').",
  }),
  trend: Schema.Literals(["up", "down", "flat"]).annotate({
    description: "Overall direction of the main chart across the visible period.",
  }),
  headline: Schema.Array(HeadlineMetric).annotate({
    description: "The dashboard's stat tiles, read verbatim. Empty if none are visible.",
  }),
  anomalies: Schema.Array(Anomaly).annotate({
    description:
      "Spikes, dips, or breaks in the main chart worth a human's attention. Empty if the period is unremarkable.",
  }),
  summary: Schema.String.annotate({
    description:
      "Two or three sentences a busy human reads instead of the dashboard: trend, anything unusual, what to look into.",
  }),
})

export type Briefing = typeof Briefing.Type

const briefingFormat = StructuredFormat.fromEffectSchema(Briefing)

export type BriefingConfig = {
  readonly model: string
  /** The dashboard to read. */
  readonly url: string
  /**
   * How long to let the page render before the screenshot. A fixed wait
   * beats a readiness selector here: it needs no knowledge of the
   * dashboard's internals, and a vision judge only needs the page to look
   * settled.
   */
  readonly settle: Duration.Input
}

/** Typed failure channel: browser transport + model + briefing decode. */
export type BriefingError =
  | BrowserError.BrowserError
  | AiError.AiError
  | Turn.RefusalRejected
  | StructuredFormat.JsonParseError
  | StructuredFormat.StructuredDecodeError

// ---------------------------------------------------------------------------
// The vision turn.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are an analyst reading a screenshot of a web dashboard. Report only",
  "what is visible in the image. Read stat tiles verbatim; describe chart",
  "shapes using the chart's own axis labels; mark estimated magnitudes with",
  "~. Never invent numbers that are not on screen.",
].join(" ")

const briefingRequest = (screenshot: Uint8Array): Items.Message => ({
  type: "message",
  role: "user",
  content: [
    { type: "input_image", source: Image.imageBytes(screenshot, "image/png") },
    {
      type: "input_text",
      text: "Brief me on this dashboard: period, headline numbers, trend, and anything a human should look into.",
    },
  ],
})

/**
 * Read one dashboard into a typed briefing. Opens a scoped browser session,
 * lets the dashboard render, screenshots the full page, and decodes a
 * single vision turn against the `Briefing` schema. The session is
 * disposed on scope close.
 */
export const briefDashboard = (
  cfg: BriefingConfig,
): Effect.Effect<Briefing, BriefingError, CoreBrowser.Browser | LanguageModel.LanguageModel> =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* CoreBrowser.create({
        timeout: "2 minutes",
        viewport: { width: 1440, height: 1024 },
      })
      yield* session.goto(cfg.url)
      yield* Effect.sleep(cfg.settle)

      const screenshot = yield* session.screenshot({ fullPage: true })
      yield* Effect.logDebug(`screenshot captured (${screenshot.length} bytes)`)

      const turn = yield* LanguageModel.turn({
        model: cfg.model,
        history: [Items.systemText(SYSTEM_PROMPT), briefingRequest(screenshot)],
        structured: briefingFormat,
      })
      return yield* Turn.decodeStructured(turn, briefingFormat)
    }),
  )
