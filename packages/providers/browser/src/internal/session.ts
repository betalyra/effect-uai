/**
 * Builds a core `BrowserSession` over one attached CDP target.
 *
 * Verb mechanics (the hybrid split):
 * - Real input (`click`, `dblclick`, `hover`, `press`, `type`, `check`)
 *   goes through the CDP `Input` domain, so events are trusted where the
 *   engine distinguishes (obscura implements `Input.dispatch*`; full
 *   Chrome obviously does).
 * - Everything DOM-shaped (`query`, `fill`, `select`, `waitFor`,
 *   `content`, scrolling) runs as injected TypeScript from `injected.ts`
 *   via `Runtime.evaluate`, the lowest-common-denominator CDP method.
 *   Results are decoded with the wire schemas, never cast.
 * - `goto` awaits the `Page` load event through the transport's event
 *   demux; `waitFor` parks a `MutationObserver` promise in the page via
 *   `awaitPromise`. The host never polls.
 *
 * Failures: transport `CdpError`s are mapped here onto the public
 * `BrowserError` taxonomy with the operation each verb knows. Expiry (max
 * lifetime / idle) is enforced locally by scoped reaper fibers; after
 * expiry every verb fails `BrowserSessionExpired`.
 */
import * as CoreBrowser from "@effect-uai/core/Browser"
import * as BrowserError from "@effect-uai/core/BrowserError"
import { Clock, Duration, Effect, Encoding, Option, PubSub, Ref, Schema, type Scope } from "effect"
import type { Cdp, CdpError, CdpEvent, CdpParams, CdpReturn } from "./cdp.js"
import {
  agentExpression,
  InjectedBox,
  InjectedElementInfo,
  InjectedPoint,
  InjectedSize,
  type PageAgentApi,
} from "./injected.js"

// Per-operation defaults. `waitFor` runs the same budget inside the page
// (the MutationObserver self-times-out) with the host bound as a backstop.
const NAVIGATE_BUDGET = Duration.seconds(30)
const WAITFOR_BUDGET = Duration.seconds(10)
const ACTION_BUDGET = Duration.seconds(30)
const WAITFOR_BACKSTOP = Duration.millis(Duration.toMillis(WAITFOR_BUDGET) + 5000)

/** `query` returns at most this many matches to bound payload size. */
const QUERY_LIMIT = 100

/** Reply errors that mean "this endpoint does not implement the method". */
export const isMethodMissing = (e: CdpError): boolean =>
  e.kind === "reply" &&
  /wasn't found|not found|unknown method|not implemented|unsupported/i.test(e.reason ?? "")

const KEY_DETAILS: Record<
  string,
  { readonly code: string; readonly keyCode: number; readonly text?: string }
> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
}

// ---------------------------------------------------------------------------
// Boundary decoders: CDP leaves these values untyped (`any`), so they are
// decoded rather than cast.
// ---------------------------------------------------------------------------

const decodeLifecycleParams = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }))
const decodeAxString = Schema.decodeUnknownOption(Schema.String)
const decodeAxValue = Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Number]))
const decodeElements = Schema.decodeUnknownEffect(Schema.Array(InjectedElementInfo))

// ---------------------------------------------------------------------------
// Accessibility tree: flat AXNode list -> recursive core AxNode. Ignored
// nodes are elided, their children promoted.
// ---------------------------------------------------------------------------

type RawAxNode = CdpReturn<"Accessibility.getFullAXTree">["nodes"][number]

const buildAxTree = (nodes: ReadonlyArray<RawAxNode>): CoreBrowser.AxNode => {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const childrenOf = (node: RawAxNode): Array<CoreBrowser.AxNode> =>
    (node.childIds ?? []).flatMap((childId) => {
      const child = byId.get(childId)
      if (child === undefined) return []
      return child.ignored ? childrenOf(child) : [build(child)]
    })
  const build = (node: RawAxNode): CoreBrowser.AxNode => {
    const name = Option.filter(decodeAxString(node.name?.value), (s) => s !== "")
    const value = Option.filter(
      Option.map(decodeAxValue(node.value?.value), String),
      (s) => s !== "",
    )
    return {
      role: Option.getOrElse(decodeAxString(node.role?.value), () => "unknown"),
      ...(Option.isSome(name) ? { name: name.value } : {}),
      ...(Option.isSome(value) ? { value: value.value } : {}),
      children: childrenOf(node),
    }
  }
  const root = nodes.find((n) => n.parentId === undefined) ?? nodes[0]
  if (root === undefined) return { role: "document", children: [] }
  return root.ignored ? { role: "document", children: childrenOf(root) } : build(root)
}

// ---------------------------------------------------------------------------
// Session builder
// ---------------------------------------------------------------------------

export type MakeSessionOptions = {
  readonly cdp: Cdp
  readonly id: CoreBrowser.BrowserSessionId
  /** CDP target session id (flatten mode); routes every command. */
  readonly sessionId: string
  readonly provider: string
  readonly request: CoreBrowser.CommonSessionRequest
  /** Best-effort provider-side teardown, run when the session expires. */
  readonly dispose: Effect.Effect<void>
}

export const makeSession = (
  options: MakeSessionOptions,
): Effect.Effect<CoreBrowser.BrowserSession, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { cdp, dispose, id, provider, request, sessionId } = options

    // -- expiry: local reaper fibers, scoped to the session -------------------

    const expired = yield* Ref.make(false)
    const lastActivity = yield* Ref.make(yield* Clock.currentTimeMillis)
    const expire = Ref.set(expired, true).pipe(Effect.andThen(Effect.ignore(dispose)))

    if (request.timeout !== undefined) {
      yield* Effect.sleep(request.timeout).pipe(Effect.andThen(expire), Effect.forkScoped)
    }
    if (request.idleTimeout !== undefined) {
      const idleMs = Duration.toMillis(Duration.fromInputUnsafe(request.idleTimeout))
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            const elapsed = (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastActivity))
            if (elapsed >= idleMs) return yield* expire
            yield* Effect.sleep(Duration.millis(idleMs - elapsed))
          }
        }),
      )
    }

    // -- error mapping and shared wrappers -------------------------------------

    const sessionExpired = () => new BrowserError.BrowserSessionExpired({ provider, id })

    const mapCdp =
      (operation: BrowserError.BrowserActionFailed["operation"], selector?: string) =>
      (e: CdpError): BrowserError.BrowserError =>
        e.kind === "closed"
          ? sessionExpired()
          : new BrowserError.BrowserActionFailed({
              provider,
              operation,
              ...(selector !== undefined ? { selector } : {}),
              ...(e.reason !== undefined ? { reason: e.reason } : {}),
              raw: e,
            })

    const guarded = <A, E>(
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | BrowserError.BrowserSessionExpired> =>
      Effect.gen(function* () {
        if (yield* Ref.get(expired)) return yield* Effect.fail(sessionExpired())
        yield* Ref.set(lastActivity, yield* Clock.currentTimeMillis)
        return yield* effect
      })

    const withBudget = <A, E>(
      operation: BrowserError.BrowserTimeout["operation"],
      budget: Duration.Duration,
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | BrowserError.BrowserTimeout> =>
      Effect.timeoutOrElse(effect, {
        duration: budget,
        orElse: () => Effect.fail(new BrowserError.BrowserTimeout({ provider, operation, budget })),
      })

    const evalInPage = (
      expression: string,
      operation: BrowserError.BrowserActionFailed["operation"],
      selector?: string,
    ): Effect.Effect<unknown, BrowserError.BrowserError> =>
      cdp
        .send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        )
        .pipe(
          Effect.mapError(mapCdp(operation, selector)),
          Effect.flatMap((reply) =>
            reply.exceptionDetails !== undefined
              ? Effect.fail(
                  new BrowserError.BrowserActionFailed({
                    provider,
                    operation,
                    ...(selector !== undefined ? { selector } : {}),
                    reason:
                      reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text,
                    raw: reply.exceptionDetails,
                  }),
                )
              : Effect.succeed(reply.result.value as unknown),
          ),
        )

    /** Call a page-agent helper and decode its result with `schema`. */
    const agent = <S extends Schema.Top & { readonly DecodingServices: never }>(
      operation: BrowserError.BrowserActionFailed["operation"],
      fn: keyof PageAgentApi,
      args: ReadonlyArray<unknown>,
      schema: S,
      selector?: string,
    ): Effect.Effect<S["Type"], BrowserError.BrowserError> =>
      evalInPage(agentExpression(fn, args), operation, selector).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(schema)(value).pipe(
            Effect.mapError(
              (e) =>
                new BrowserError.BrowserActionFailed({
                  provider,
                  operation,
                  ...(selector !== undefined ? { selector } : {}),
                  reason: "page agent returned an unexpected shape",
                  raw: e,
                }),
            ),
          ),
        ),
      )

    /** Call a page-agent helper whose result is irrelevant. */
    const agentVoid = (
      operation: BrowserError.BrowserActionFailed["operation"],
      fn: keyof PageAgentApi,
      args: ReadonlyArray<unknown>,
      selector?: string,
    ): Effect.Effect<void, BrowserError.BrowserError> =>
      evalInPage(agentExpression(fn, args), operation, selector).pipe(Effect.asVoid)

    // -- input primitives (trusted events via the Input domain) ----------------

    const mouse = (params: CdpParams<"Input.dispatchMouseEvent">) =>
      cdp.send("Input.dispatchMouseEvent", params, sessionId)

    const clickAt = (point: InjectedPoint, clickCount: number): Effect.Effect<void, CdpError> =>
      Effect.gen(function* () {
        yield* mouse({ type: "mouseMoved", x: point.x, y: point.y })
        yield* mouse({ type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount })
        yield* mouse({ type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount })
      })

    const clickSelector = (selector: string, clickCount: number) =>
      agent("interact", "targetPoint", [selector], InjectedPoint, selector).pipe(
        Effect.flatMap((point) =>
          clickAt(point, clickCount).pipe(Effect.mapError(mapCdp("interact", selector))),
        ),
      )

    const keyEvents = (key: string): Effect.Effect<void, CdpError> => {
      const detail = KEY_DETAILS[key]
      const text = detail?.text ?? (key.length === 1 ? key : undefined)
      const common =
        detail === undefined
          ? {}
          : {
              code: detail.code,
              windowsVirtualKeyCode: detail.keyCode,
              nativeVirtualKeyCode: detail.keyCode,
            }
      return cdp
        .send(
          "Input.dispatchKeyEvent",
          { type: "keyDown", key, ...common, ...(text !== undefined ? { text } : {}) },
          sessionId,
        )
        .pipe(
          Effect.andThen(
            cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, ...common }, sessionId),
          ),
          Effect.asVoid,
        )
    }

    // -- navigation --------------------------------------------------------------

    const isLoadEvent = (event: CdpEvent): boolean =>
      (event.sessionId === undefined || event.sessionId === sessionId) &&
      (event.method === "Page.loadEventFired" ||
        (event.method === "Page.lifecycleEvent" &&
          Option.getOrUndefined(decodeLifecycleParams(event.params))?.name === "load"))

    const goto = (url: string) =>
      guarded(
        Effect.scoped(
          Effect.gen(function* () {
            // Subscribe BEFORE navigating so the load event cannot slip past.
            const sub = yield* cdp.subscribe
            const reply = yield* cdp
              .send("Page.navigate", { url }, sessionId)
              .pipe(Effect.mapError(mapCdp("navigate")))
            if (reply.errorText !== undefined && reply.errorText !== "") {
              return yield* Effect.fail(
                new BrowserError.BrowserActionFailed({
                  provider,
                  operation: "navigate",
                  reason: reply.errorText,
                  raw: reply,
                }),
              )
            }
            yield* PubSub.take(sub).pipe(Effect.repeat({ until: isLoadEvent }))
          }),
        ).pipe((effect) =>
          Effect.timeoutOrElse(effect, {
            duration: NAVIGATE_BUDGET,
            // Endpoints that don't emit load events still settle the
            // document; accept a complete readyState before failing.
            orElse: () =>
              agent("navigate", "readyState", [], Schema.String).pipe(
                Effect.option,
                Effect.flatMap((state) =>
                  Option.isSome(state) && state.value === "complete"
                    ? Effect.void
                    : Effect.fail(
                        new BrowserError.BrowserTimeout({
                          provider,
                          operation: "navigate",
                          budget: NAVIGATE_BUDGET,
                        }),
                      ),
                ),
              ),
          }),
        ),
      )

    const waitFor = (selector: string) =>
      guarded(
        withBudget(
          "query",
          WAITFOR_BACKSTOP,
          agent(
            "observe",
            "waitForSelector",
            [selector, Duration.toMillis(WAITFOR_BUDGET)],
            Schema.Boolean,
            selector,
          ).pipe(
            Effect.flatMap((found) =>
              found
                ? Effect.void
                : Effect.fail(
                    new BrowserError.BrowserTimeout({
                      provider,
                      operation: "query",
                      budget: WAITFOR_BUDGET,
                    }),
                  ),
            ),
          ),
        ),
      )

    // -- observation ---------------------------------------------------------------

    const content = (format?: CoreBrowser.PageFormat) =>
      guarded(
        withBudget(
          "action",
          ACTION_BUDGET,
          agent("observe", format === "html" ? "html" : "markdown", [], Schema.String),
        ),
      )

    const screenshot = (opts?: CoreBrowser.ScreenshotOptions) =>
      guarded(
        withBudget(
          "action",
          ACTION_BUDGET,
          Effect.gen(function* () {
            const clip =
              opts?.selector !== undefined
                ? yield* agent("observe", "pageBox", [opts.selector], InjectedBox, opts.selector)
                : opts?.fullPage === true
                  ? { x: 0, y: 0, ...(yield* agent("observe", "contentSize", [], InjectedSize)) }
                  : undefined
            const reply = yield* cdp
              .send(
                "Page.captureScreenshot",
                {
                  format: "png",
                  ...(clip !== undefined
                    ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true }
                    : {}),
                },
                sessionId,
              )
              .pipe(Effect.mapError(mapCdp("observe")))
            return yield* Effect.fromResult(Encoding.decodeBase64(reply.data)).pipe(
              Effect.mapError(
                (e) =>
                  new BrowserError.BrowserActionFailed({
                    provider,
                    operation: "observe",
                    reason: "invalid base64 screenshot payload",
                    raw: e,
                  }),
              ),
            )
          }),
        ),
      )

    const snapshot = guarded(
      withBudget(
        "query",
        ACTION_BUDGET,
        cdp.send("Accessibility.getFullAXTree", {}, sessionId).pipe(
          Effect.mapError((e) =>
            isMethodMissing(e)
              ? new BrowserError.BrowserUnsupported({
                  provider,
                  capability: "snapshot",
                  reason: "endpoint does not implement the CDP Accessibility domain",
                })
              : mapCdp("observe")(e),
          ),
          Effect.map((reply) => buildAxTree(reply.nodes)),
        ),
      ),
    )

    const query = (selector: string) =>
      guarded(
        withBudget(
          "query",
          ACTION_BUDGET,
          evalInPage(agentExpression("query", [selector, QUERY_LIMIT]), "observe", selector).pipe(
            Effect.flatMap((value) =>
              decodeElements(value).pipe(
                Effect.mapError(
                  (e) =>
                    new BrowserError.BrowserActionFailed({
                      provider,
                      operation: "observe",
                      selector,
                      reason: "page agent returned an unexpected shape",
                      raw: e,
                    }),
                ),
              ),
            ),
            Effect.map((els) =>
              els.map((el): CoreBrowser.ElementInfo => ({
                ref: el.ref,
                tag: el.tag,
                ...(el.text !== "" ? { text: el.text } : {}),
                attributes: el.attributes,
                box: el.box,
              })),
            ),
          ),
        ),
      )

    // -- state -----------------------------------------------------------------------

    const cookies: CoreBrowser.CookieApi = {
      get: guarded(
        cdp.send("Network.getCookies", {}, sessionId).pipe(
          Effect.mapError(mapCdp("cookies")),
          Effect.map((reply) =>
            reply.cookies.map((c): CoreBrowser.Cookie => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              expires: c.expires,
              httpOnly: c.httpOnly,
              secure: c.secure,
              ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
            })),
          ),
        ),
      ),
      set: (toSet) =>
        guarded(
          cdp
            .send(
              "Network.setCookies",
              {
                cookies: toSet.map((c) => ({
                  name: c.name,
                  value: c.value,
                  ...(c.domain !== undefined ? { domain: c.domain } : {}),
                  ...(c.path !== undefined ? { path: c.path } : {}),
                  ...(c.expires !== undefined ? { expires: c.expires } : {}),
                  ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
                  ...(c.secure !== undefined ? { secure: c.secure } : {}),
                  ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
                })),
              },
              sessionId,
            )
            .pipe(Effect.mapError(mapCdp("cookies")), Effect.asVoid),
        ),
    }

    // -- assemble ----------------------------------------------------------------------

    const interact = <A>(effect: Effect.Effect<A, BrowserError.BrowserError>) =>
      guarded(withBudget("action", ACTION_BUDGET, effect))

    const session: CoreBrowser.BrowserSession = {
      id,

      goto,
      waitFor,

      click: (selector) => interact(clickSelector(selector, 1)),
      dblclick: (selector) =>
        interact(
          // Two pairs, the second with clickCount 2, matching real
          // double-click event streams.
          agent("interact", "targetPoint", [selector], InjectedPoint, selector).pipe(
            Effect.flatMap((point) =>
              clickAt(point, 1).pipe(
                Effect.andThen(clickAt(point, 2)),
                Effect.mapError(mapCdp("interact", selector)),
              ),
            ),
          ),
        ),
      fill: (selector, text) => interact(agentVoid("interact", "fill", [selector, text], selector)),
      type: (selector, text) =>
        interact(
          agentVoid("interact", "focusEl", [selector], selector).pipe(
            Effect.andThen(
              Effect.forEach(Array.from(text), keyEvents).pipe(
                Effect.asVoid,
                Effect.mapError(mapCdp("interact", selector)),
              ),
            ),
          ),
        ),
      press: (key) => interact(keyEvents(key).pipe(Effect.mapError(mapCdp("interact")))),
      hover: (selector) =>
        interact(
          agent("interact", "targetPoint", [selector], InjectedPoint, selector).pipe(
            Effect.flatMap((point) =>
              mouse({ type: "mouseMoved", x: point.x, y: point.y }).pipe(
                Effect.asVoid,
                Effect.mapError(mapCdp("interact", selector)),
              ),
            ),
          ),
        ),
      focus: (selector) => interact(agentVoid("interact", "focusEl", [selector], selector)),
      select: (selector, value) =>
        interact(agentVoid("interact", "selectValue", [selector, value], selector)),
      check: (selector) =>
        interact(
          agent("interact", "isChecked", [selector], Schema.Boolean, selector).pipe(
            Effect.flatMap((checked) => (checked ? Effect.void : clickSelector(selector, 1))),
          ),
        ),
      uncheck: (selector) =>
        interact(
          agent("interact", "isChecked", [selector], Schema.Boolean, selector).pipe(
            Effect.flatMap((checked) => (checked ? clickSelector(selector, 1) : Effect.void)),
          ),
        ),
      scroll: (opts) =>
        interact(agentVoid("interact", "scrollBy", [opts.direction, opts.pixels ?? 600])),
      scrollIntoView: (selector) =>
        interact(agentVoid("interact", "scrollIntoView", [selector], selector)),

      content,
      screenshot,
      snapshot,
      query,

      cookies,
      evaluate: (script) => interact(evalInPage(script, "evaluate")),
    }

    return session
  })
