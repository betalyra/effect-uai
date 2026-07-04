import { Effect, Schema } from "effect"
import * as Tool from "../tool/Tool.js"
import * as Toolkit from "../tool/Toolkit.js"
import type { BrowserSession } from "./Browser.js"

// ---------------------------------------------------------------------------
// Model-facing argument schemas. Annotated so the descriptions reach the
// model through the rendered JSON Schema (JSDoc does not).
// ---------------------------------------------------------------------------

const GotoArgs = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute URL to navigate to." }),
})

const ClickArgs = Schema.Struct({
  ref: Schema.String.annotate({
    description: "A CSS selector, or an element @ref if a page-reading tool provides one.",
  }),
})

const FillArgs = Schema.Struct({
  ref: Schema.String.annotate({
    description: "A CSS selector (or element @ref) of the input to fill.",
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

// ---------------------------------------------------------------------------
// Uniform action outcome: the model always learns where the action left it.
// ---------------------------------------------------------------------------

const currentUrl = (session: BrowserSession): Effect.Effect<string> =>
  session.evaluate("location.href").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
    Effect.orElseSucceed(() => "(unknown)"),
  )

const okAt = (session: BrowserSession): Effect.Effect<string> =>
  Effect.map(currentUrl(session), (url) => `ok (now at ${url})`)

// ---------------------------------------------------------------------------
// The canonical browser action tools, each closed over a live `BrowserSession`
// and failing with the full `BrowserError`. `Output` is a compact outcome
// (`ok (now at <url>)`), not a page dump - a page-reading tool is the recipe's
// to define, so history does not accumulate a full page per action.
//
// A failed action (stale ref, dead control, timeout) fails typed on the error
// channel. Whether the model gets to recover from it is the loop's decision:
// wrap the toolkit in `Toolkit.describeFailures(BrowserError.describe)` to
// surface failures to the model, or map selectively to keep session/infra
// errors (e.g. `BrowserSessionExpired`) fatal.
//
// Browser actions are order-dependent (fill, then press Enter): run a turn's
// calls with `{ concurrency: 1 }`.
// ---------------------------------------------------------------------------

export const gotoTool = (session: BrowserSession) =>
  Tool.make({
    name: "browser_goto",
    description: "Navigate the browser to an absolute URL.",
    inputSchema: Tool.fromEffectSchema(GotoArgs),
    run: (args) =>
      Effect.andThen(session.goto(args.url), okAt(session)).pipe(
        Effect.withSpan("browser_goto", {
          kind: "client",
          attributes: { "browser.url": args.url },
        }),
      ),
  })

export const clickTool = (session: BrowserSession) =>
  Tool.make({
    name: "browser_click",
    description: "Click the element named by ref. A click may navigate to a new page.",
    inputSchema: Tool.fromEffectSchema(ClickArgs),
    run: (args) =>
      Effect.andThen(session.click(args.ref), okAt(session)).pipe(
        Effect.withSpan("browser_click", {
          kind: "client",
          attributes: { "browser.ref": args.ref },
        }),
      ),
  })

export const fillTool = (session: BrowserSession) =>
  Tool.make({
    name: "browser_fill",
    description:
      "Put text into the input named by ref. Filling alone does not submit; press Enter to submit the input.",
    inputSchema: Tool.fromEffectSchema(FillArgs),
    run: (args) =>
      Effect.andThen(session.fill(args.ref, args.text), okAt(session)).pipe(
        Effect.withSpan("browser_fill", {
          kind: "client",
          attributes: { "browser.ref": args.ref },
        }),
      ),
  })

export const pressTool = (session: BrowserSession) =>
  Tool.make({
    name: "browser_press",
    description: "Press a keyboard key against the focused element.",
    inputSchema: Tool.fromEffectSchema(PressArgs),
    run: (args) =>
      Effect.andThen(session.press(args.key), okAt(session)).pipe(
        Effect.withSpan("browser_press", {
          kind: "client",
          attributes: { "browser.key": args.key },
        }),
      ),
  })

export const scrollTool = (session: BrowserSession) =>
  Tool.make({
    name: "browser_scroll",
    description:
      "Scroll the viewport. Only useful to bring an element into view - a page-reading tool's text is already scroll-independent.",
    inputSchema: Tool.fromEffectSchema(ScrollArgs),
    run: (args) =>
      Effect.andThen(session.scroll({ direction: args.direction }), okAt(session)).pipe(
        Effect.withSpan("browser_scroll", {
          kind: "client",
          attributes: { "browser.direction": args.direction },
        }),
      ),
  })

/**
 * The canonical browser action verbs bundled as a `Toolkit`, closed over a
 * live `BrowserSession`. Compose it with a recipe-local page-reading tool and
 * whatever finish/signal tools the agent needs:
 *
 *   const toolkit = yield* Toolkit.compose(
 *     browserToolkit(session),
 *     Toolkit.make(readPageTool(session), finishTool),
 *   )
 *
 * For an à-la-carte subset, use the individual `gotoTool` / `clickTool` / …
 * constructors directly. Run a turn's calls with `{ concurrency: 1 }`.
 */
export const browserToolkit = (session: BrowserSession) =>
  Toolkit.make(
    gotoTool(session),
    clickTool(session),
    fillTool(session),
    pressTool(session),
    scrollTool(session),
  )
