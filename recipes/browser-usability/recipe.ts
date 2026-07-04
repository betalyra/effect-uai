/**
 * Agent usability testing. Give the agent a goal in plain language and a
 * start URL; it drives a real browser toward the goal and returns a typed
 * report: did it get there, what path it took, and where the UI tripped it
 * up.
 *
 * The agent steers itself. The model gets the canonical `browserToolkit`
 * (navigate, click, fill, press, scroll), a recipe-local read-page tool, and
 * a `finish` signal tool carrying the report schema, and decides each step
 * what to do next.
 * The recipe is just the standard tool-calling loop: `Loop.loop` +
 * `onTurnComplete` + `Toolkit.run`, the same machinery as every other agent
 * recipe. Swap the engine for any CDP endpoint by changing only the Layer
 * in `app.ts`.
 *
 * Grounding is deliberately vision-free: `browser_read_page` returns the
 * page as markdown plus interactive elements (each carrying an `@ref`
 * usable as a selector). That even works against a partial CDP engine like
 * obscura, which has no accessibility domain and needs no screenshots.
 */
import { Data, Effect, Option, pipe, Schema, Stream } from "effect"
import type * as AiError from "@effect-uai/core/AiError"
import * as CoreBrowser from "@effect-uai/core/Browser"
import * as BrowserError from "@effect-uai/core/BrowserError"
import { browserToolkit } from "@effect-uai/core/BrowserTool"
import * as Items from "@effect-uai/core/Items"
import * as LanguageModel from "@effect-uai/core/LanguageModel"
import * as Loop from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import type * as ToolEvent from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as ToolResult from "@effect-uai/core/ToolResult"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// The finish signal: how the run ends. A signal tool is model-visible but
// never executed - the loop intercepts it, decodes the report from its
// arguments, and stops. Keeping the report schema on the tool (rather than
// a structured-output turn) stays in tool space, which every provider's
// tool-calling path supports.
// ---------------------------------------------------------------------------

const FinishArgs = Schema.Struct({
  goalAchieved: Schema.Boolean.annotate({
    description: "Whether the goal was actually accomplished.",
  }),
  summary: Schema.String.annotate({
    description: "Two or three sentences: what happened and where the run ended.",
  }),
  friction: Schema.Array(Schema.String).annotate({
    description:
      "UX friction encountered on the way: confusing labels, dead ends, broken or hidden controls. Empty if none.",
  }),
})

const finishTool = Tool.signal({
  name: "finish",
  description:
    "End the usability test and file the report. Call it as soon as the goal is met, or when you are stuck with no way forward.",
  inputSchema: Tool.fromEffectSchema(FinishArgs),
})

// ---------------------------------------------------------------------------
// Read-page tool. Rendering a page for a model (markdown budget, interactive
// element listing, the @ref protocol) is app policy, so it lives in the
// recipe rather than in core's action verbs. Grounding is vision-free: the
// page comes back as markdown plus interactive elements, each carrying an
// @ref usable as a selector in browser_click / browser_fill.
// ---------------------------------------------------------------------------

const MARKDOWN_BUDGET = 6000
const ELEMENT_BUDGET = 50
const INTERACTIVE =
  "a, button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem]"
const SHOWN_ATTRS = ["href", "name", "id", "type", "placeholder", "value", "aria-label", "role"]

const attrPairs = (el: CoreBrowser.ElementInfo): string =>
  SHOWN_ATTRS.flatMap((key) => {
    const value = el.attributes[key]
    return value === undefined || value === ""
      ? []
      : [`${key}=${JSON.stringify(value.slice(0, 60))}`]
  }).join(" ")

const describeElement = (el: CoreBrowser.ElementInfo): string => {
  const text = el.text === undefined || el.text === "" ? "" : ` "${el.text.slice(0, 60)}"`
  const attrs = attrPairs(el)
  return `${el.ref} <${el.tag}>${text}${attrs === "" ? "" : ` ${attrs}`}`
}

const currentUrl = (session: CoreBrowser.BrowserSession): Effect.Effect<string> =>
  session.evaluate("location.href").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
    Effect.orElseSucceed(() => "(unknown)"),
  )

const readPageTool = (session: CoreBrowser.BrowserSession) =>
  Tool.make({
    name: "browser_read_page",
    description:
      "Read the current page: its full main content as markdown plus the interactive elements, each with an @ref usable in browser_click / browser_fill. Call it after navigating or acting to see the result.",
    inputSchema: Tool.noInput,
    run: () =>
      Effect.gen(function* () {
        const { elements, markdown, url } = yield* Effect.all(
          {
            url: currentUrl(session),
            markdown: session.content("markdown"),
            elements: session.query(INTERACTIVE),
          },
          { concurrency: 3 },
        )
        const shown = elements.slice(0, ELEMENT_BUDGET).map(describeElement).join("\n")
        const page =
          markdown.length > MARKDOWN_BUDGET
            ? `${markdown.slice(0, MARKDOWN_BUDGET)}\n[content continues beyond ${MARKDOWN_BUDGET} chars; scrolling will NOT reveal more of this text]`
            : markdown
        return [
          `CURRENT URL: ${url}`,
          "",
          "PAGE (markdown, full page content regardless of scroll position):",
          page,
          "",
          `INTERACTIVE ELEMENTS (${elements.length} found, showing ${Math.min(elements.length, ELEMENT_BUDGET)}):`,
          shown === "" ? "(none)" : shown,
        ].join("\n")
      }).pipe(Effect.withSpan("browser_read_page", { kind: "client" })),
  })

// A failed action (stale ref, dead control, timeout) is signal the model can
// adapt to, so describe it to a model-visible string. Session/infra errors
// stay typed on the error channel and end the run - the model cannot revive a
// dead session. This selective mapping is the middleware pattern from the
// tool-failure design.
const MODEL_ACTIONABLE: ReadonlyArray<string> = [
  "BrowserTimeout",
  "BrowserActionFailed",
  "BrowserInvalidRequest",
  "BrowserUnsupported",
]

const recoverActionable: Toolkit.Middleware<never, string> = (run) => (input, emit) =>
  run(input, emit).pipe(
    Effect.mapError((e) => {
      const err = e as BrowserError.BrowserError
      return MODEL_ACTIONABLE.includes(err._tag) ? BrowserError.describe(err) : e
    }),
  )

// ---------------------------------------------------------------------------
// Report types.
// ---------------------------------------------------------------------------

/** One executed step, recorded for the report's trail. */
export type StepRecord = {
  readonly n: number
  /** The tool call, e.g. `browser_click {"ref":"@e4"}`. */
  readonly action: string
  /** The model's text alongside the call, when it thought out loud. */
  readonly reasoning: string
  /** What the tool returned, clipped: `ok (now at ...)` or a failure. */
  readonly outcome: string
}

export class UsabilityReport extends Data.TaggedClass("UsabilityReport")<{
  readonly goal: string
  readonly goalAchieved: boolean
  readonly summary: string
  readonly friction: ReadonlyArray<string>
  readonly stepsUsed: number
  readonly trail: ReadonlyArray<StepRecord>
}> {}

export type UsabilityConfig = {
  readonly model: string
  readonly goal: string
  readonly startUrl: string
  /** Hard cap on model turns before the agent is forced to finish. */
  readonly maxSteps: number
}

/** Typed failure channel: browser transport + model + finish-args decode. */
export type UsabilityError =
  | BrowserError.BrowserError
  | AiError.AiError
  | Tool.ToolError
  | Tool.ToolValidationError
  | Toolkit.DuplicateToolName

// ---------------------------------------------------------------------------
// Prompt.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a usability tester driving a real web browser toward a goal,",
  "using the browser_* tools. After navigating or acting, call",
  "browser_read_page to see the result: it returns the page's full main",
  "content as markdown (independent of scroll position) plus the interactive",
  "elements, each with an @ref for browser_click / browser_fill. To submit a",
  "search box, browser_fill it, then browser_press Enter; filling alone does",
  "not submit. Refs go stale after navigation; read the page again instead",
  "of reusing them. A tool result carrying an error explains why an action",
  "did not work: adapt rather than repeating it. As soon as the page content",
  "answers the goal, or you are stuck with no way forward, call finish with",
  "your report, listing any UX friction you hit along the way.",
].join(" ")

// ---------------------------------------------------------------------------
// Trail bookkeeping: project each executed tool call + its result onto a
// compact `StepRecord` so the final report can show the path taken.
// ---------------------------------------------------------------------------

const clip = (s: string, max = 120): string => (s.length > max ? `${s.slice(0, max)}...` : s)

const summarizeCall = (call: Items.ToolCall): string => `${call.name} ${clip(call.arguments, 80)}`

const outcomeOf = (results: ReadonlyArray<ToolResult.ToolResult>, call: Items.ToolCall): string =>
  Option.match(Option.fromNullishOr(results.find((r) => r.call_id === call.call_id)), {
    onNone: () => "(no result)",
    onSome: ToolResult.ToolResult.$match({
      Ok: ({ value }) => clip(String(value)),
      Failure: (f) => `failed (${f.kind})${f.reason === undefined ? "" : `: ${f.reason}`}`,
    }),
  })

const appendTrail = (
  trail: ReadonlyArray<StepRecord>,
  turn: Turn.Turn,
  calls: ReadonlyArray<Items.ToolCall>,
  results: ReadonlyArray<ToolResult.ToolResult>,
): ReadonlyArray<StepRecord> => {
  const reasoning = Turn.assistantText(turn).trim()
  return [
    ...trail,
    ...calls.map((call, i) => ({
      n: trail.length + i + 1,
      action: summarizeCall(call),
      reasoning,
      outcome: outcomeOf(results, call),
    })),
  ]
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

type State = {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly round: number
  readonly trail: ReadonlyArray<StepRecord>
}

const exhaustedReport = (cfg: UsabilityConfig, trail: ReadonlyArray<StepRecord>): UsabilityReport =>
  new UsabilityReport({
    goal: cfg.goal,
    goalAchieved: false,
    summary: `Step budget (${cfg.maxSteps}) exhausted before the goal was reached.`,
    friction: [],
    stepsUsed: trail.length,
    trail,
  })

/**
 * What the loop's body emits besides Next/Stop decisions: tool events for
 * observability, and finally the report itself. One explicit type so the
 * branches of `onTurnComplete` unify.
 */
type BodyEvent = UsabilityReport | ToolEvent.ToolEvent
type BodyStep = Loop.Step<BodyEvent, State>
/** Error union every `onTurnComplete` branch unifies to. */
type BodyError = BrowserError.BrowserError | Tool.ToolError | Tool.ToolValidationError

const emitAndStop = (report: UsabilityReport): Stream.Stream<BodyStep, BodyError> =>
  Stream.concat(Stream.make(Loop.value(report)), Loop.stop())

/**
 * Drive one goal to completion. Opens a scoped browser session, hands the
 * model the browser toolkit plus the `finish` signal, and loops turns until
 * the model files its report or the step budget forces one. The session
 * (and its CDP target) is disposed on scope close.
 */
export const runUsabilityTest = (
  cfg: UsabilityConfig,
): Effect.Effect<
  UsabilityReport,
  UsabilityError,
  CoreBrowser.Browser | LanguageModel.LanguageModel
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* CoreBrowser.create({ timeout: "5 minutes" })
      yield* session.goto(cfg.startUrl)

      // Browser action verbs + the recipe-local read-page tool + the finish
      // signal, with actionable failures described to the model and session
      // errors left typed to end the run.
      const actions = Toolkit.wrap(
        yield* Toolkit.compose(
          browserToolkit(session),
          Toolkit.make(readPageTool(session), finishTool),
        ),
        recoverActionable,
      )
      // On the last allowed round the model only sees `finish`, forcing a
      // report - so the agent always terminates with one.
      const finishOnly = Toolkit.make(finishTool)

      const initial: State = {
        history: [
          Items.systemText(SYSTEM_PROMPT),
          Items.userText(`GOAL: ${cfg.goal}\nThe browser is on ${cfg.startUrl}.`),
        ],
        round: 0,
        trail: [],
      }

      const body = (state: State) => {
        const lastRound = state.round >= cfg.maxSteps
        return LanguageModel.streamTurn({
          model: cfg.model,
          history: lastRound
            ? [
                ...state.history,
                Items.userText("Step budget exhausted. Call finish now with your report."),
              ]
            : state.history,
          tools: lastRound ? finishOnly : actions,
        }).pipe(
          Loop.onTurnComplete((turn) =>
            Effect.gen(function* () {
              const calls = Turn.getToolCalls(turn)
              const finishCall = calls.find((c) => c.name === finishTool.name)

              // The model filed its report: decode it and stop.
              if (finishCall !== undefined) {
                const args = yield* Tool.decodeArgs(finishTool, finishCall)
                return emitAndStop(
                  new UsabilityReport({
                    goal: cfg.goal,
                    goalAchieved: args.goalAchieved,
                    summary: args.summary,
                    friction: args.friction,
                    stepsUsed: state.trail.length,
                    trail: state.trail,
                  }),
                )
              }

              // Budget gone and still no report: synthesize one.
              if (lastRound) return emitAndStop(exhaustedReport(cfg, state.trail))

              // Text without tool calls: remind it the report goes through finish.
              if (calls.length === 0) {
                const nudge: Stream.Stream<BodyStep> = Loop.next(
                  Turn.appendToHistory({ ...state, round: state.round + 1 }, turn, [
                    Items.userText(
                      "Use the browser_* tools to act, or call finish with your report.",
                    ),
                  ]),
                )
                return nudge
              }

              yield* Effect.logInfo(
                `step ${state.round + 1}: ${calls.map(summarizeCall).join("; ")}`,
              )

              // Execute the calls in order (browser actions are order-
              // dependent: fill, then press Enter) and continue with the
              // results appended to history and trail.
              const act: Stream.Stream<BodyStep, BrowserError.BrowserError> = Toolkit.run(
                actions,
                calls,
                { concurrency: 1 },
              ).pipe(
                Toolkit.continueWithResults((results) =>
                  Toolkit.appendToolResults(
                    {
                      ...state,
                      round: state.round + 1,
                      trail: appendTrail(state.trail, turn, calls, results),
                    },
                    turn,
                  )(results),
                ),
              )
              return act
            }),
          ),
        )
      }

      const found = yield* pipe(
        initial,
        Loop.loop(body),
        Stream.filter((event): event is UsabilityReport => event instanceof UsabilityReport),
        Stream.runHead,
      )
      return yield* Option.match(found, {
        onSome: Effect.succeed,
        onNone: () => Effect.die(new Error("usability loop ended without a report")),
      })
    }),
  )
