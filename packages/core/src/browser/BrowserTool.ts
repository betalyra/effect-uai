import { Effect, Result, Schema } from "effect"
import * as Tool from "../tool/Tool.js"
import type { BrowserSession, ElementInfo } from "./Browser.js"
import * as BrowserError from "./BrowserError.js"

// ---------------------------------------------------------------------------
// Model-facing argument schemas. Annotated so the descriptions reach the
// model through the rendered JSON Schema (JSDoc does not).
// ---------------------------------------------------------------------------

const GotoArgs = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute URL to navigate to." }),
})

const ClickArgs = Schema.Struct({
  ref: Schema.String.annotate({
    description: "An @ref from browser_read_page, or any CSS selector.",
  }),
})

const FillArgs = Schema.Struct({
  ref: Schema.String.annotate({
    description: "An @ref from browser_read_page, or any CSS selector, of the input to fill.",
  }),
  text: Schema.String.annotate({ description: "The text to put in the input." }),
})

const PressArgs = Schema.Struct({
  key: Schema.String.annotate({
    description: 'Key to press, e.g. "Enter" to submit the focused input, "Tab", "Escape".',
  }),
})

const ScrollArgs = Schema.Struct({
  direction: Schema.Literals(["up", "down"]).annotate({
    description: "Scroll the viewport up or down.",
  }),
})

const ReadPageArgs = Schema.Struct({})

// ---------------------------------------------------------------------------
// Failure mapping. A failed action (stale ref, non-fillable element, dead
// navigation) is signal the model adapts to, so it lands in the `Result`
// failure. Session/infra problems stay on the error channel - the model
// cannot revive a dead session.
// ---------------------------------------------------------------------------

const MODEL_ACTIONABLE = [
  "BrowserTimeout",
  "BrowserActionFailed",
  "BrowserInvalidRequest",
  "BrowserUnsupported",
] as const

type ModelActionable = Extract<
  BrowserError.BrowserError,
  { _tag: (typeof MODEL_ACTIONABLE)[number] }
>

const isModelActionable = (e: BrowserError.BrowserError): e is ModelActionable =>
  (MODEL_ACTIONABLE as ReadonlyArray<string>).includes(e._tag)

const asResult = <R>(
  effect: Effect.Effect<string, BrowserError.BrowserError, R>,
): Effect.Effect<
  Result.Result<string, string>,
  Exclude<BrowserError.BrowserError, ModelActionable>,
  R
> =>
  effect.pipe(
    Effect.map(Result.succeed),
    Effect.catchIf(isModelActionable, (e) =>
      Effect.succeed(Result.fail(BrowserError.describe(e))),
    ),
  )

// ---------------------------------------------------------------------------
// Page rendering for browser_read_page.
// ---------------------------------------------------------------------------

const INTERACTIVE =
  "a, button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem]"

const SHOWN_ATTRS = ["href", "name", "id", "type", "placeholder", "value", "aria-label", "role"]

const attrPairs = (el: ElementInfo): string =>
  SHOWN_ATTRS.flatMap((key) => {
    const value = el.attributes[key]
    return value === undefined || value === ""
      ? []
      : [`${key}=${JSON.stringify(value.slice(0, 60))}`]
  }).join(" ")

const describeElement = (el: ElementInfo): string => {
  const text = el.text === undefined || el.text === "" ? "" : ` "${el.text.slice(0, 60)}"`
  const attrs = attrPairs(el)
  return `${el.ref} <${el.tag}>${text}${attrs === "" ? "" : ` ${attrs}`}`
}

const currentUrl = (session: BrowserSession): Effect.Effect<string> =>
  session.evaluate("location.href").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
    Effect.orElseSucceed(() => "(unknown)"),
  )

/** Uniform action outcome: the model always learns where the action left it. */
const okAt = (session: BrowserSession): Effect.Effect<string> =>
  Effect.map(currentUrl(session), (url) => `ok (now at ${url})`)

export type BrowserToolsOptions = {
  /**
   * App-fixed ceiling on page markdown characters per `browser_read_page`
   * call - a context cost guard, not exposed to the model. Default `6000`.
   */
  readonly markdownBudget?: number
  /** Max interactive elements listed per read. Default `50`. */
  readonly elementBudget?: number
  /**
   * CSS selector defining which elements `browser_read_page` lists as
   * interactive. Default covers links, buttons, form fields, and the
   * corresponding ARIA roles.
   */
  readonly interactiveSelector?: string
}

/**
 * The canonical browser action tools, closed over a live `BrowserSession`.
 * Spread them into a `Toolkit` and the model drives the page itself:
 *
 *   const toolkit = Toolkit.make(...browserTools(session))
 *
 * Each tool's `Output` is `Result<string, string>`. Action tools succeed
 * with a compact outcome (`ok (now at <url>)`), not a page dump - the model
 * calls `browser_read_page` when it wants to look, so history does not
 * accumulate a full page per action. A failed action (stale ref, dead
 * control, timeout) lands in the `Result` failure as a model-readable
 * message, because for an agent it is information to adapt to; session and
 * infra errors stay on the error channel.
 *
 * When passing several action calls from one turn to `Toolkit.run`, run
 * them with `{ concurrency: 1 }` - browser actions are order-dependent
 * (fill, then press Enter).
 *
 * This is a simple default implementation for quick use. For more elaborate
 * cases (a different output contract, more verbs, another page rendering),
 * build your own tools with `Tool.make` over the same session verbs.
 */
export const browserTools = (session: BrowserSession, options?: BrowserToolsOptions) => {
  const markdownBudget = options?.markdownBudget ?? 6000
  const elementBudget = options?.elementBudget ?? 50
  const interactiveSelector = options?.interactiveSelector ?? INTERACTIVE

  const readPage = Effect.gen(function* () {
    const { elements, markdown, url } = yield* Effect.all(
      {
        url: currentUrl(session),
        markdown: session.content("markdown"),
        elements: session.query(interactiveSelector),
      },
      { concurrency: 3 },
    )
    const shown = elements.slice(0, elementBudget).map(describeElement).join("\n")
    // The markdown is the whole page's main content, independent of scroll
    // position. If it is over budget we cut the tail; say so without implying
    // that scrolling would reveal the rest (it would not).
    const page =
      markdown.length > markdownBudget
        ? `${markdown.slice(0, markdownBudget)}\n[content continues beyond ${markdownBudget} chars; scrolling will NOT reveal more of this text]`
        : markdown
    return [
      `CURRENT URL: ${url}`,
      "",
      "PAGE (markdown, full page content regardless of scroll position):",
      page,
      "",
      `INTERACTIVE ELEMENTS (${elements.length} found, showing ${Math.min(elements.length, elementBudget)}):`,
      shown === "" ? "(none)" : shown,
    ].join("\n")
  })

  return [
    Tool.make({
      name: "browser_goto",
      description: "Navigate the browser to an absolute URL.",
      inputSchema: Tool.fromEffectSchema(GotoArgs),
      run: (args) =>
        asResult(Effect.andThen(session.goto(args.url), okAt(session))).pipe(
          Effect.withSpan("browser_goto", {
            kind: "client",
            attributes: { "browser.url": args.url },
          }),
        ),
    }),
    Tool.make({
      name: "browser_click",
      description: "Click the element named by ref. A click may navigate to a new page.",
      inputSchema: Tool.fromEffectSchema(ClickArgs),
      run: (args) =>
        asResult(Effect.andThen(session.click(args.ref), okAt(session))).pipe(
          Effect.withSpan("browser_click", {
            kind: "client",
            attributes: { "browser.ref": args.ref },
          }),
        ),
    }),
    Tool.make({
      name: "browser_fill",
      description:
        "Put text into the input named by ref. Filling alone does not submit; press Enter to submit the input.",
      inputSchema: Tool.fromEffectSchema(FillArgs),
      run: (args) =>
        asResult(Effect.andThen(session.fill(args.ref, args.text), okAt(session))).pipe(
          Effect.withSpan("browser_fill", {
            kind: "client",
            attributes: { "browser.ref": args.ref },
          }),
        ),
    }),
    Tool.make({
      name: "browser_press",
      description: "Press a keyboard key against the focused element.",
      inputSchema: Tool.fromEffectSchema(PressArgs),
      run: (args) =>
        asResult(Effect.andThen(session.press(args.key), okAt(session))).pipe(
          Effect.withSpan("browser_press", {
            kind: "client",
            attributes: { "browser.key": args.key },
          }),
        ),
    }),
    Tool.make({
      name: "browser_scroll",
      description:
        "Scroll the viewport. Only useful to bring an element into view - page text from browser_read_page is already scroll-independent.",
      inputSchema: Tool.fromEffectSchema(ScrollArgs),
      run: (args) =>
        asResult(Effect.andThen(session.scroll({ direction: args.direction }), okAt(session))).pipe(
          Effect.withSpan("browser_scroll", {
            kind: "client",
            attributes: { "browser.direction": args.direction },
          }),
        ),
    }),
    Tool.make({
      name: "browser_read_page",
      description:
        "Read the current page: its full main content as markdown plus the interactive elements, each with an @ref usable in browser_click / browser_fill. Call it after navigating or acting to see the result.",
      inputSchema: Tool.fromEffectSchema(ReadPageArgs),
      run: () => asResult(readPage).pipe(Effect.withSpan("browser_read_page", { kind: "client" })),
    }),
  ] as const
}
